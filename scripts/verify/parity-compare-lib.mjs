// Field-by-field comparison of two parity dumps. Pure: the CLI lives in parity-compare.mjs.

/**
 * @typedef {{ kind: "value" | "missing" | "extra", path: string, base: string, head: string }} Difference
 * @typedef {{ path: string, kind?: Difference["kind"], relative?: number, absolute?: number, reason: string, ticket?: string }} AcceptedEntry
 */

/** Token amounts (raw and formatted) and unitless ratios, relative / absolute. */
export const AMOUNT_TOLERANCE = 1e-5;
/** USD values, relative. */
export const USD_TOLERANCE = 1e-3;

// Ratios live in [0, 1], so a relative bound would be needlessly strict near zero.
const RATIO_PATH = /(^|\.)(lltv|ltv|relativeCap|vaultSupplyShare|utilization)(\.|$)/i;
const USD_KEY = /(usd|aum)/i;
const AMOUNT_KEY = /^(raw|formatted|supplyShares)$/;

// Entities are matched by identity, not position: a reordered list is not a difference.
const IDENTITY_KEYS = [
  "vaultAddress",
  "adapterAddress",
  "marketId",
  "market.marketId",
  "bucketTimestamp",
  "asset.address",
  "address",
];

/** How a numeric leaf is compared, from its path. */
export function toleranceFor(path) {
  const key = path.slice(path.lastIndexOf(".") + 1);
  if (USD_KEY.test(key)) return { kind: "usd", relative: USD_TOLERANCE };
  // A WAD-scaled `raw` is an integer in the 1e18 range: only a relative bound means anything there.
  if (RATIO_PATH.test(path) && key !== "raw") return { kind: "ratio", absolute: AMOUNT_TOLERANCE };
  if (AMOUNT_KEY.test(key)) return { kind: "amount", relative: AMOUNT_TOLERANCE };
  return { kind: "exact" };
}

function asNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(value)) return Number(value);
  return null;
}

function withinTolerance(path, a, b) {
  if (a === b) return true;
  const tolerance = toleranceFor(path);
  if (tolerance.kind === "exact") return false;
  const x = asNumber(a);
  const y = asNumber(b);
  if (x === null || y === null) return false;
  const delta = Math.abs(x - y);
  if (tolerance.absolute !== undefined) return delta <= tolerance.absolute;
  return delta <= tolerance.relative * Math.max(Math.abs(x), Math.abs(y));
}

function get(object, dotted) {
  let value = object;
  for (const part of dotted.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

function identityKey(base, head) {
  const items = [...base, ...head];
  if (items.length === 0 || !items.every((item) => item !== null && typeof item === "object")) return null;
  for (const key of IDENTITY_KEYS) {
    const unique = (list) => {
      const ids = list.map((item) => get(item, key));
      return ids.every((id) => id !== undefined && id !== null) && new Set(ids.map(String)).size === ids.length;
    };
    if (unique(base) && unique(head)) return key;
  }
  return null;
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const describe = (value) => (value === undefined ? "(absent)" : JSON.stringify(value));

/**
 * Compares two dump `data` trees. Returns every difference with its JSON path, plus the chart points
 * left out because they fall outside the window both dumps cover.
 */
export function diffDumps(base, head) {
  /** @type {Difference[]} */
  const differences = [];
  let trimmedPoints = 0;

  const push = (kind, path, a, b) => differences.push({ kind, path, base: describe(a), head: describe(b) });

  const walk = (a, b, path) => {
    if (a === undefined && b === undefined) return;
    if (a === undefined) return push("extra", path, a, b);
    if (b === undefined) return push("missing", path, a, b);

    if (Array.isArray(a) && Array.isArray(b)) return walkArray(a, b, path);
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path}.${key}`);
      return;
    }
    if (Array.isArray(a) !== Array.isArray(b) || isPlainObject(a) !== isPlainObject(b)) {
      return push("value", path, a, b);
    }
    if (!withinTolerance(path, a, b)) push("value", path, a, b);
  };

  const walkArray = (a, b, path) => {
    const primitive = (list) => list.every((item) => item === null || typeof item !== "object");
    if (primitive(a) && primitive(b)) {
      // Address lists (sentinels): membership matters, order does not.
      const left = new Set(a.map(String));
      const right = new Set(b.map(String));
      for (const item of left) if (!right.has(item)) push("missing", `${path}[${item}]`, item, undefined);
      for (const item of right) if (!left.has(item)) push("extra", `${path}[${item}]`, undefined, item);
      return;
    }

    const key = identityKey(a, b);
    if (key === null) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }

    let left = a;
    let right = b;
    if (key === "bucketTimestamp" && a.length > 0 && b.length > 0) {
      // Chart series: a dump taken minutes later can gain or drop the bucket at each end of a rolling
      // window, so up to one point per end per side is left out. Anything more is lost coverage, and
      // a bucket missing inside the common window is still a difference.
      const time = (point) => Number(point.bucketTimestamp);
      const from = Math.max(Math.min(...a.map(time)), Math.min(...b.map(time)));
      const to = Math.min(Math.max(...a.map(time)), Math.max(...b.map(time)));
      const outside = (list) => ({
        before: list.filter((point) => time(point) < from).length,
        after: list.filter((point) => time(point) > to).length,
      });
      const span = (list) => `${list.length} points, ${Math.min(...list.map(time))} to ${Math.max(...list.map(time))}`;
      const edges = [outside(a), outside(b)];
      if (from > to) {
        differences.push({ kind: "value", path: `${path}(window)`, base: span(a), head: span(b) });
        return;
      }
      if (edges.some((edge) => edge.before > 1 || edge.after > 1)) {
        const [base, head] = edges.map((edge) => edge.before + edge.after);
        const kind = (base ?? 0) > (head ?? 0) ? "missing" : "extra";
        differences.push({ kind, path: `${path}(window)`, base: span(a), head: span(b) });
      }
      left = a.filter((point) => time(point) >= from && time(point) <= to);
      right = b.filter((point) => time(point) >= from && time(point) <= to);
      trimmedPoints += a.length - left.length + (b.length - right.length);
    }

    const byId = (list) => new Map(list.map((item) => [String(get(item, key)), item]));
    const leftById = byId(left);
    const rightById = byId(right);
    for (const id of new Set([...leftById.keys(), ...rightById.keys()])) {
      walk(leftById.get(id), rightById.get(id), `${path}[${id}]`);
    }
  };

  walk(base, head, "data");
  return { differences, trimmedPoints };
}

/** `*` matches within one path segment (`.`-separated), `**` across segments. */
export function globToRegExp(glob) {
  const segment = (part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*");
  return new RegExp(`^${glob.split("**").map(segment).join(".*")}$`);
}

// An entry with `relative` or `absolute` only accepts numeric value differences inside that bound,
// so a drift allowance never hides a wrong value.
function withinEntryBound(entry, difference) {
  if (entry.relative === undefined && entry.absolute === undefined) return true;
  if (difference.kind !== "value") return false;
  const x = asNumber(JSON.parse(difference.base));
  const y = asNumber(JSON.parse(difference.head));
  if (x === null || y === null) return false;
  const delta = Math.abs(x - y);
  if (entry.absolute !== undefined && delta > entry.absolute) return false;
  if (entry.relative !== undefined && delta > entry.relative * Math.max(Math.abs(x), Math.abs(y))) return false;
  return true;
}

/**
 * Splits differences into accepted (matching an entry of the list) and unexpected. An entry
 * matches on `path`, on `kind` (value, missing, extra) when set, and on its bound when set.
 */
/**
 * @param {Difference[]} differences
 * @param {AcceptedEntry[]} acceptedList
 */
export function classify(differences, acceptedList) {
  const rules = acceptedList.map((entry) => ({ entry, regexp: globToRegExp(entry.path), hits: 0 }));
  const accepted = [];
  const unexpected = [];
  for (const difference of differences) {
    const rule = rules.find(
      ({ entry, regexp }) =>
        regexp.test(difference.path) &&
        (!entry.kind || entry.kind === difference.kind) &&
        withinEntryBound(entry, difference),
    );
    if (rule) {
      rule.hits += 1;
      accepted.push({ ...difference, reason: rule.entry.reason, ticket: rule.entry.ticket });
    } else {
      unexpected.push(difference);
    }
  }
  return { accepted, unexpected, unused: rules.filter((rule) => rule.hits === 0).map((rule) => rule.entry) };
}
