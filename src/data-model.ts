
export type Timestamp = number;
export type ISO8601Timestamp = string;
export type Md5Hash = string;
export type Currency = number;
export type CurrencyPerDay = number;

export type Uuid = string;
export type ActionId = Uuid;
export type StateId = Uuid;
export type ListId = Uuid;
export type ItemId = Uuid;

// The non-event-sourced part of the state
export interface Snapshot {
  id: StateId;
  lists: List[];
  time: ISO8601Timestamp;
  nextNonlinearity: ISO8601Timestamp;
  // Note that the hash is computed from the history that lead up to the
  // snapshot, not from the content of the snapshot. The hash of the snapshot is
  // equal to the hash of the last action folded into the snapshot (see
  // `calculateActionHash` and `foldAction`)
  hash: Md5Hash;
}

export interface List {
  id: ListId;
  name: string;
  items: Item[];
  budget: BudgetAmount;
  kitty: LinearAmount;
  purchaseHistory: PurchaseHistoryItem[];
}

// https://github.com/microsoft/TypeScript/issues/39556#issuecomment-656925230
export type UnionOmit<T, K extends string | number | symbol> = T extends unknown ? Omit<T, K> : never;

export type StateHistory = Action[];

// The structure saved to the database or localStorage, combining both the list
// of actions and the latest snapshot that results from accumulating the actions.
export interface StateBlobStructure extends Snapshot {
  actions: StateHistory;
}

export interface BudgetAmount {
  dollars: Currency;
  unit: '/month';
}

export interface LinearAmount {
  value: Currency; // The value as measured at `Snapshot.time` timestamp
  rate: CurrencyPerDay; // Rate of change in dollars per day
}

export interface Item {
  id: ItemId;
  name?: string;
  price: Currency;
  saved: LinearAmount;
  note?: string;
  expectedDate?: ISO8601Timestamp | 'never';
}

export interface PurchaseHistoryItem {
  id: ItemId;
  name?: string;
  priceEstimate: Currency;
  price: Currency;
  purchaseDate: ISO8601Timestamp;
}

export interface ActionBase {
  id: ActionId;
  time: ISO8601Timestamp;
  hash: Md5Hash;
}

export interface ListActionBase extends ActionBase {
  listId: ListId;
}

export interface ItemActionBase extends ActionBase {
  itemId: ItemId;
}

export type Action =
  | NewState
  | MigrateState
  | ListNew
  | ListDelete
  | ListSetName
  | ListSetBudget
  | ListInjectMoney
  | ItemNew
  | ItemMove
  | ItemDelete
  | ItemSetName
  | ItemSetPrice
  | ItemSetNote
  | ItemPurchase
  | ItemRedistributeMoney
  | UndoAction
  | RedoAction

// A new action is an action that hasn't yet been added to the action history.
// This is for convenience, since we can have a common place where the id, time,
// and hash are computed
export type NewAction = UnionOmit<Action, 'id' | 'time' | 'hash'>;
export type ActionWithoutHash = UnionOmit<Action, 'hash'>;

// Actions

export interface NewState extends ActionBase { type: 'New' }
export interface MigrateState extends ActionBase { type: 'MigrateState', state: Snapshot }

export interface ListNew extends ActionBase { type: 'ListNew', name: string }
export interface ListDelete extends ListActionBase { type: 'ListDelete', listId: ListId }
export interface ListSetName extends ListActionBase { type: 'ListSetName', newName: string }
export interface ListSetBudget extends ListActionBase { type: 'ListSetBudget', budget: BudgetAmount }
export interface ListInjectMoney extends ListActionBase { type: 'ListInjectMoney', amount: number }

export interface ItemNew extends ListActionBase { type: 'ItemNew' }
export interface ItemMove extends ItemActionBase { type: 'ItemMove', targetListId: ListId, targetIndex: number }
export interface ItemDelete extends ItemActionBase { type: 'ItemDelete' }
export interface ItemSetName extends ItemActionBase { type: 'ItemSetName', name: string }
export interface ItemSetPrice extends ItemActionBase { type: 'ItemSetPrice', price: Currency }
export interface ItemSetNote extends ItemActionBase { type: 'ItemSetNote', note: string }
export interface ItemPurchase extends ItemActionBase { type: 'ItemPurchase', actualPrice: Currency }
export interface ItemRedistributeMoney extends ItemActionBase { type: 'ItemRedistributeMoney' }

export interface UndoAction extends ActionBase { type: 'Undo', actionIdToUndo: ActionId }
export interface RedoAction extends ActionBase { type: 'Redo', actionIdToRedo: ActionId }

export type SyncStatus = 'sync-pending' | 'sync-failure' | 'sync-success';
export type AppMode = 'electron-local' | 'web-local' | 'online';

export interface UserInfo {
  id: string;
  name: string;
}