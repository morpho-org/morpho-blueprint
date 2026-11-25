import type { Apy } from '@/common/data/types';
import type { MarketBorrowApyWindows } from '@/modules/market/market.types';

import { APP_CONFIG } from '@/config';

export function extractMarketBorrowApy(market: MarketBorrowApyWindows): Apy {
  switch (APP_CONFIG.apyWindow) {
    case '6h':
      return market.borrowApy6h;
    case '1d':
      return market.borrowApy1d;
    case '7d':
      return market.borrowApy7d;
    case '30d':
      return market.borrowApy30d;
  }
}
