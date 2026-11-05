// Outside Next there is no incremental cache: every read goes upstream, as a cold request would.
export const unstable_cache = <T>(fn: T): T => fn;
export const revalidateTag = () => {};
export const revalidatePath = () => {};
