/**
 * The XBRL concepts the app reads from SEC EDGAR's companyfacts, per input and taxonomy, in order of
 * preference. Shared by the site's function (netlify/functions/fundamentals.mts), which relays only these,
 * and the parser (src/data/sec.ts). No imports: the function bundles it on its own.
 */
export const SEC_CONCEPTS = {
  'us-gaap': {
    revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'],
    operatingIncome: ['OperatingIncomeLoss'],
    da: ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'DepreciationAmortizationAndAccretionNet'],
    depreciation: ['Depreciation'],
    amortization: ['AmortizationOfIntangibleAssets'],
    netIncome: ['NetIncomeLoss', 'ProfitLoss'],
    eps: ['EarningsPerShareDiluted'],
    pretax: [
      'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
      'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
    ],
    tax: ['IncomeTaxExpenseBenefit'],
    equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    cash: ['CashAndCashEquivalentsAtCarryingValue'],
    shortInvestments: ['ShortTermInvestments', 'MarketableSecuritiesCurrent', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'],
    debtTotal: ['DebtLongtermAndShorttermCombinedAmount'],
    longTermDebt: ['LongTermDebt'],
    debtNoncurrent: ['LongTermDebtNoncurrent'],
    debtCurrent: ['DebtCurrent'],
    ltdCurrent: ['LongTermDebtCurrent'],
    shortBorrowings: ['ShortTermBorrowings', 'CommercialPaper'],
    shares: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted'],
  },
  'ifrs-full': {
    revenue: ['Revenue', 'RevenueFromContractsWithCustomers'],
    operatingIncome: ['ProfitLossFromOperatingActivities'],
    da: ['DepreciationAndAmortisationExpense'],
    depreciation: ['DepreciationExpense', 'DepreciationPropertyPlantAndEquipmentIncludingRightofuseAssets'],
    amortization: ['AmortisationExpense', 'AmortisationIntangibleAssetsOtherThanGoodwill'],
    netIncome: ['ProfitLossAttributableToOwnersOfParent', 'ProfitLoss'],
    eps: ['DilutedEarningsLossPerShare'],
    pretax: ['ProfitLossBeforeTax'],
    tax: ['IncomeTaxExpenseContinuingOperations'],
    equity: ['EquityAttributableToOwnersOfParent', 'Equity'],
    cash: ['CashAndCashEquivalents'],
    shortInvestments: [],
    debtTotal: ['Borrowings'],
    longTermDebt: [],
    debtNoncurrent: [],
    debtCurrent: [],
    ltdCurrent: [],
    shortBorrowings: [],
    shares: [],
  },
} as const;

export type Taxonomy = keyof typeof SEC_CONCEPTS;
export type SecRole = keyof (typeof SEC_CONCEPTS)['us-gaap'];

/** Annual and quarterly reports; 6-K (foreign interim, unaudited) and other forms are left out. */
export const SEC_FORMS = /^(10-K|10-Q|20-F|40-F|10-KT)(\/A)?$/;
