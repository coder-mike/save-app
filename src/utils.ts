import { BudgetAmount } from "./data-model";


export function getAllocatedRate(budget: BudgetAmount) {
  if (budget.unit === '/month')
    return budget.dollars * 12 / 365.25;
  else
  if (budget.unit === '/day')
    return budget.dollars;
  else
    throw new Error('Unknown unit')
}