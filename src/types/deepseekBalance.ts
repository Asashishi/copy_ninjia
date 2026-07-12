export interface DeepSeekBalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

export interface DeepSeekBalanceResponse {
  is_available: boolean;
  balance_infos: DeepSeekBalanceInfo[];
}
