"use client";
import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { getAddress } from "viem";

import { Table } from "@/common/components/ui/table";
import { APP_CONFIG } from "@/config";
import type { Market } from "@/modules/market/data/getMarket";
import { Avatar } from "../../../common/components/ui/avatar";
import NumberFlow from "../../../common/components/ui/number-flow";
import { TotalSupplyTooltip } from "../../vault/components/TotalSupplyTooltip";
import { VaultName } from "../../vault/components/VaultName";

interface VaultAllocationTableProps {
  market: Market;
}

type Column = ColumnDef<Market["vaultAllocations"][number]>;
const columns: Column[] = [
  {
    id: "vault",
    accessorFn: (row) => row.vault.name,
    header: "Vault Name",
    cell: ({ row }) => {
      const { vault } = row.original;
      return <VaultName {...vault} chainClassName="border-[var(--row-color)] bg-[var(--row-color)]" />;
    },
    minSize: 260,
  },
  ...(!APP_CONFIG.featureFlags.hideCurator
    ? [
        {
          id: "curator",
          accessorFn: (row) => row.vault.metadata?.curator?.name ?? "",
          header: "Curator",
          cell: ({ row }) => {
            const { vault } = row.original;
            const curator = vault.metadata?.curator;
            return (
              curator && <Avatar src={curator.image} alt={curator.name} size="sm" className="rounded-full border" />
            );
          },
          minSize: 130,
        } as Column,
      ]
    : []),
  {
    id: "supplyShare",
    accessorKey: "marketSupplyShare",
    header: "Supply Share",
    cell: ({ row }) => {
      const { marketSupplyShare } = row.original;
      return <NumberFlow value={marketSupplyShare} format={{ style: "percent" }} />;
    },
    minSize: 160,
  },
  {
    id: "totalSupply",
    accessorFn: (row) => row.position.supplyAmount.usd ?? 0,
    header: "Total Supply",
    cell: ({ row }) => {
      const { position, supplyCap } = row.original;
      return (
        <TotalSupplyTooltip
          totalSupply={position.supplyAmount.usd ?? 0}
          supplyCap={supplyCap.usd}
          iconPosition="left"
        />
      );
    },
    minSize: 160,
  },
];

export function VaultAllocationTable({ market }: VaultAllocationTableProps) {
  // The configured vaults, plus every other vault V2 supplying the market when the Blueprint API is on.
  const data = useMemo(() => market.vaultAllocations.filter((allocation) => allocation.enabled), [market]);

  return (
    <Table
      columns={columns}
      data={data}
      initialSort={[{ id: "totalSupply", desc: true }]}
      // Only a configured vault has a page in the app.
      rowAction={(row) =>
        row.configured ? { type: "link", href: `/earn/${market.chain.id}/${getAddress(row.vault.vaultAddress)}` } : null
      }
    />
  );
}
