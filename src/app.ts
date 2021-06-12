
/*
# Design Notes

## Event Sourcing and Immutability

This app uses an "event sourced" pattern, meaning that events (here called
`Action`s) are the single source of truth for the current aggregate state (here
called a `Snapshot`).

Actions and snapshots are deeply immutable. The `immer` library is used locally
to generate new snapshots based on "mutations" to an old snapshot (the best
example usage is in `foldAction()`).

The rendering is done using `renderPage`, a pure function that takes a snapshot
and produces a DOM tree.

See `foldAction` which is a pure function that folds a single action into a
snapshot.

See `reduceActions` which is a pure function that takes a list of actions and
returns the final snapshot it would produce, starting from the empty snapshot.

See `mergeHistories` which collates two separate action histories for the
purposes of synchronization with the server between multiple potential users and
devices producing potentially-conflicting history (see `syncWithServer`)

Actions and snapshots are directly serializable using `JSON.stringify` and
deserializable using `JSON.parse`, meaning that they contain only
JSON-compatible POD values (for example no `Date`s or class instantiations).

The event-sourced nature of the design is also leveraged in the undo/redo
feature, since an `undo` action is simply defined as computing a snapshot from
the whole action history except the action being undone. See `undo()` for more
detail.


## Waterfall Money Model

If you use the app, you'll see that money flows from the top of the list down
into the next item, etc. I'm calling this the "waterfall money model".

The `projection()` encapsulates all the logic for this model. Given a Snapshot
at a point in time, `projection` will compute a new snapshot corresponding to
some future point, with all the new money each item will have.


## Piecewise Linear Money

It was important to me that the app show the "ticking" of money to illustrate
that the counters are continuous, since this is fundamental to the principle of
the app (e.g. you shouldn't spend money all at once when you get your salary,
you should spend it gradually over time).

Rather than refreshing the whole page every time the value changes, I instead
represent money values using a [piecewise linear
model](https://en.wikipedia.org/wiki/Piecewise_linear_function).

See the `LinearAmount` type.

When rendering a `LinearAmount` (see `renderLinearAmount`), the resulting DOM
"component" includes a baked-in timer to update the value when the display needs
to change. The `LinearAmount` itself doesn't change so often, except at points
of nonlinearity (see `Snapshot.nextNonlinearity`). It's only at points of
nonlinearity that the page needs to be re-rendered.

*/

// WORKAROUND for immer.js esm (see https://github.com/immerjs/immer/issues/557)
(window as any).process = { env: { NODE_ENV: "production" } };

import produce from 'immer'
import * as React from 'react'
import * as ReactDOM from 'react-dom';
import 'react-dom'
import { formatCurrency, Page, PageProps } from './render';
import { Action, ActionWithoutHash, AppMode, BudgetAmount, Currency, Item, ItemId, LinearAmount, List, ListId, Md5Hash, NewAction, PurchaseHistoryItem, Snapshot, StateBlobStructure, StateHistory, SyncStatus, Timestamp, UserInfo, Uuid } from './data-model';
import { getAllocatedRate, parseCurrency, parseNonNegativeCurrency } from './utils';

const svgNS = 'http://www.w3.org/2000/svg';

export class Globals {
  mode: AppMode;

  // The "state", as it used to be called, is now split into the history and
  // snapshot parts. The snapshot is immutable, but the history list is mutable
  // for performance reasons since the common thing we do with it is "append one
  // action". Actions are individually immutable when they're part of the
  // history.
  get state(): StateBlobStructure {
    return {
      ...this.snapshot,
      actions: this.actions
    }
  }
  set state(value: StateBlobStructure) {
    const { actions, ...latestState } = value;
    this.snapshot = Object.freeze(latestState);
    this.actions = actions.map(a => Object.freeze(a));
  }
  snapshot: Snapshot;
  actions: StateHistory;

  userInfo: UserInfo;
  saveState: any;
  loadState: any;

  debugMode: boolean;
  nextNonlinearity: Timestamp;
  lastCommitTime: Timestamp;
  currentListIndex: number;
  syncStatus: SyncStatus;
  nextNonLinearityTimer: any;
  dialogBackgroundEl: HTMLElement;
  draggingItem: any;
  idCounter: any;
  showingMenu: HTMLElement;
  listScrollPosition: number;

  undoHistory: any[];
  undoIndex: number;

  isEditing: boolean;
  elementBeingEdited: HTMLElement;
  editingTimeout: any;
}

const emptyHash = md5Hash('');

// These used to all be on the Window object, but I decided to put them into
// another object because in TypeScript I found it difficult to merge globals
// into the Window. I didn't want to make them lexical bindings because this way
// it's obvious that it's referencing global state.
const g = new Globals();
(window as any).g = g; // For easy debug access

declare const require: any;

const domDataAttachments = new WeakMap<HTMLElement, List | Item | PurchaseHistoryItem>();

const userInfoStorage = localStorage && localStorage.getItem('user-info');
if (userInfoStorage) g.userInfo = JSON.parse(userInfoStorage);


detectMode();

g.saveState = async () => {
  switch (g.mode) {
    case 'electron-local': {
      const fs = require('fs');
      if (!fs.existsSync('backups')) {
        fs.mkdirSync('backups');
      }
      fs.renameSync('state.json', `backups/state_${Math.round(Date.now())}.json.backup`)
      fs.writeFileSync('state.json', JSON.stringify(g.state, null, 2));
      console.log('Saved to file');
      break;
    }
    case 'web-local': {
      localStorage.setItem('squirrel-away-state', JSON.stringify(g.state));
      console.log('Saved to localStorage');
      break;
    }
    case 'online': {
      await synchronize();
      break;
    }
  }
};

g.loadState = async (renderOnChange) => {
  try {
    switch (g.mode) {
      case 'electron-local': {
        const fs = require('fs');
        g.state = upgradeStateFormat(JSON.parse(fs.readFileSync('state.json')));
        console.log('Loaded state from file');
        break;
      }
      case 'web-local': {
        const localStorageContent = localStorage.getItem('squirrel-away-state');
        if (!localStorageContent) {
          g.state = newState();
          return;
        }
        g.state = upgradeStateFormat(JSON.parse(localStorageContent));
        console.log('Loaded state from localStorage');
        break;
      }
      case 'online': {
        await synchronize(renderOnChange);
        break;
      }
    }
  } catch (e) {
    console.error(e);
    g.state = newState();
  }
}

window.addEventListener('load', onLoad);

window.addEventListener('focus', () => synchronize());

document.addEventListener('keydown', documentKeyDown);
document.addEventListener('mousedown', documentMouseDown);
window.addEventListener('blur', windowBlurEvent);

async function onLoad() {
  g.syncStatus = 'sync-pending';
  g.undoHistory = []; // List of action IDs available to undo
  g.undoIndex = 0; // Points after the last entry in undoHistory
  g.debugMode = false;
  if (g.debugMode) g.snapshot.time = serializeDate(Date.now());

  await g.loadState(false);

  // It's useful here to reconstruct the state from the actions list. For one
  // thing, if there are earlier bugs in the reducer that get fixed later,
  // running the re-reducer at startup means we recompute the correct end state.
  // Similarly, if there are new bugs in the reducer, we find out sooner rather
  // than later.
  g.snapshot = reduceActions(g.actions);

  updateState();
  render();

  // occasionallyRebuild();
}

function render() {
  console.log('Rendering');

  g.currentListIndex ??= 0;
  g.currentListIndex = Math.max(g.currentListIndex, 0);
  g.currentListIndex = Math.min(g.currentListIndex, g.snapshot.lists.length - 1);

  const pageProps: PageProps = {
    ...g,
    onUserAction: action => {
      console.log('action', action);
      addUserAction(action);
      updateState();
      save();
      render();
    }
  }

  saveScrollPosition(); // TODO: This won't be needed once we move to react
  ReactDOM.render(
    React.createElement(Page, pageProps),
    document.getElementById('page'));
  restoreScrollPosition();
}

function save() {
  if (g.debugMode) {
    console.log('Would save here');
  } else {
    g.saveState();
  }
}

function undo() {
  /* I thought through many different ways of making undo/redo work, and none of
   * them are simple. I wanted a solution with the following properties:
   *
   *   - It shouldn't require us to have an inverse of every possible action
   *     (e.g. an inverse of `ItemRedistributeMoney` that somehow recollects the
   *     money and puts it back). This mostly rules out a solution like `git
   *     revert` that appends an opposite commit (action) to undo old commits.
   *
   *   - It needs to work well with synchronization. So this rules out just
   *     "removing the undone actions", since those actions may have already
   *     reached the server and other devices. Removing them would be like
   *     removing git commits from a git history and would create a
   *     synchronization conflict. The conflict resolution favors all actions
   *     being present, so it will just add back the missing actions (as if
   *     those actions had been performed on a different device), making the
   *     undo ineffective.
   *
   *   - It needs to work with an arbitrary number of users observing the same
   *     state (or single user on multiple devices). If user A performs actions
   *     1, 3, and 5, and user B performs actions 2, 4, and 6, in an interleaved
   *     fashion (with the synchronized result being 1,2,3,4,5,6), then if user
   *     A hits "undo", it should only undo 5, and not 6. If they hit it again,
   *     it should undo action 3. (and if they redo, it should add back action 3
   *     followed by 5 as if they had never been undone)
   *
   *   - The solution also needs to work with an arbitrary number of undo/redo
   *     cycles. I thought of just adding a flag like `undone`, and then when
   *     merging states we can prioritize `undone` over not-undone, but this
   *     breaks the redo. I also thought of having an "undo version" that
   *     increments every time a user performs a meta-action (undoing or redoing
   *     an action) but this sacrifices the immutability of the action stream.
   *
   *   - I'd like a solution that maintains the audit trail. If somebody injects
   *     money into a list and then undoes the injection, this is equivalent to
   *     injecting the opposite amount. It would be good to have a history of
   *     this undoing rather than silently pretending that it never happened.
   *     I'm thinking especially of multi-user scenarios and of diagnosing
   *     issues.
   *
   * The solution I settled on is this:
   *
   * Undo and redo are actions that get appended to the action stream like any
   * other action, for auditing and synchronization purposes. They reference the
   * action being undone or redone (by ID).
   *
   * We define the behavior of an Undo action as producing a state that is
   * equivalent to the state that would have been produced by the same action
   * history but with the referenced action omitted.
   *
   * As with all other actions, the hash produced by an undo action must be
   * computed from the hash of the previous action plus the hash of the undo
   * itself. This means that the hash still includes both the original action
   * and the undo, so both of these are real actions that occurred in the
   * history. Doing it this way is important for fast-forward merging of states
   * from different devices.
   *
   * In concrete implementation:
   *
   *   1. Every action the user performs calls `addUserAction` which appends the
   *      action ID to the undoHistory list. Note that user actions can be
   *      interleaved with actions from other devices/users so the undoHistory
   *      does not necessarily contain all the actions.
   *
   *   2. When the user does ctrl+Z, we add an "Undo" action referencing the
   *      last action in the undoHistory list.
   *
   *   3. Folding an Undo action (in `foldAction`) just recomputes the new state
   *      by re-running the reducer over the state using `reduceActions`. If
   *      this becomes a performance bottleneck in future, it's easy to add
   *      checkpointing so not the whole history needs to be visited.
   *
   *   4. `reduceActions` runs 2 passes. The first pass computes all the actions
   *      to skip because they were "undone". The second pass reduces over the
   *      non-undo actions using `foldAction`.
   *
   * Note that `foldAction` and `reduceActions` are in some sense mutually
   * recursive, but `reduceActions` suppresses the effects of `Undo` actions in
   * `foldAction` by running the initial pass. The naive implementation may have
   * had exponential asymptotic performance (exponential to the number of undos
   * in the history) since later undos need to recalculate the whole history
   * before them, including earlier undos which calculate the whole history
   * before *them*, etc. The double-pass instead gets this done in linear time.
   *
   * This design is also very robust to conflicting edits. E.g.
   *
   *   1. User X adds item A
   *   2. User Y modifies item A
   *   3. User X "undoes" action #1, so item A disappears (including user Ys
   *      edits). User Ys modifications are still present in the history but
   *      have no effect since the item being affected no longer exists.
   *   4. User X "redoes" action #1, thereby reintroducing item A, *including
   *      user Y's edits to item A*.
   *
   * Part of the reason that this works is that `foldAction` is designed to
   * handle apparently-meaningless actions, such as "change the name of item A"
   * when no "item A" exists.
   */

  // Can't undo past the beginning
  if (g.undoIndex <= 0) return;

  const actionIdToUndo = g.undoHistory[--g.undoIndex];
  doAction({ type: 'Undo', actionIdToUndo });

  updateState();
  save();
  render();
}

function redo() {
  // Can't redo past the end
  if (g.undoIndex >= g.undoHistory.length) return;

  // Restore to the state
  const actionIdToRedo = g.undoHistory[g.undoIndex++];
  doAction({ type: 'Redo', actionIdToRedo });

  updateState();
  save();
  render();
}

export function renderNavigator(state: Snapshot) {
  const navEl = document.createElement('div');
  navEl.classList.add('nav-panel');

  const userPanel = navEl.appendChild(document.createElement('div'))
  userPanel.classList.add('user-panel')
  const userStatusEl = userPanel.appendChild(document.createElement('div'))
  userStatusEl.classList.add('user-status');
  const userPanelButtonsEl = userPanel.appendChild(document.createElement('div'))
  userPanelButtonsEl.classList.add('user-panel-buttons');
  if (g.mode === 'online') {
    if (g.syncStatus !== 'sync-failure') {
      userStatusEl.innerHTML = `Hi, ${g.userInfo.name}`;
    } else {
      userStatusEl.innerHTML = `Connection error`;
    }

    const signOutButton = userPanelButtonsEl.appendChild(document.createElement('button'));
    signOutButton.className = 'sign-out';
    signOutButton.textContent = 'Sign out';
    signOutButton.addEventListener('click', signOutClick);
  } else if (g.mode === 'web-local') {
    userStatusEl.innerHTML = 'Your lists are currently stored locally';

    const signUpButton = userPanelButtonsEl.appendChild(document.createElement('button'));
    signUpButton.className = 'sign-up';
    signUpButton.textContent = 'New account';
    signUpButton.addEventListener('click', signUpClick);

    const signInButton = userPanelButtonsEl.appendChild(document.createElement('button'));
    signInButton.className = 'sign-in';
    signInButton.textContent = 'Sign in';
    signInButton.addEventListener('click', signInClick);
  }

  const listsSection = navEl.appendChild(document.createElement('div'));
  listsSection.classList.add('lists-section');

  const listListEl = listsSection.appendChild(document.createElement('ul'));
  listListEl.classList.add('list-nav');

  for (const [i, list] of state.lists.entries()) {
    const listHasReadyItems = list.items.some(item => item.saved.value && item.saved.value >= item.price);

    const itemEl = listListEl.appendChild(document.createElement('li'));
    domDataAttachments.set(itemEl, list);
    itemEl.classList.add('nav-item');
    if (listHasReadyItems) itemEl.classList.add('has-ready-items');
    if (i === g.currentListIndex) itemEl.classList.add('active');
    itemEl.addEventListener('click', navListItemClick);

    const nameEl = itemEl.appendChild(document.createElement('h1'));
    nameEl.textContent = list.name;

    if (listHasReadyItems) {
      const readyIndicator = itemEl.appendChild(createReadyIndicatorSvg());
      readyIndicator.classList.add('ready-indicator');
    }

    const allocatedAmount = Math.round(getAllocatedRate(list.budget) * 365.25 / 12);
    if (allocatedAmount) {
      const allocatedEl = itemEl.appendChild(renderCurrency(allocatedAmount, 0));
      allocatedEl.classList.add('allocated');
    }
  }

  const newListButtonContainer = listsSection.appendChild(document.createElement('div'));
  newListButtonContainer.className = 'button-new-container';

  const newListButton = newListButtonContainer.appendChild(document.createElement('button'));
  newListButton.classList.add('button-new', 'svg-button');
  newListButton.addEventListener('click', newListClick);
  newListButton.appendChild(renderPlusSvg());

  // Totals
  navEl.appendChild(renderTotals(state));

  // Report issues
  const reportIssuesEl = navEl.appendChild(document.createElement('div'));
  reportIssuesEl.className = 'report-issues';
  reportIssuesEl.innerHTML = '<a href="https://github.com/coder-mike/squirrel-away/issues" target="_blank">Feedback or problems</a>';

  return navEl;
}

function renderTotals(state: Snapshot) {
  const totalsSection = document.createElement('div');
  totalsSection.classList.add('totals-section');

  let totalBudget = 0;
  let totalSavedValue = 0;
  let totalSavedRate = 0;
  for (const list of state.lists) {
    totalBudget += getAllocatedRate(list.budget) * 365.25 / 12;
    totalSavedValue += list.kitty.value;
    totalSavedRate += list.kitty.rate;
    for (const item of list.items) {
      totalSavedValue += item.saved.value;
      totalSavedRate += item.saved.rate;
    }
  }

  const table = totalsSection.appendChild(document.createElement('table'));
  let tr = table.appendChild(document.createElement('tr'));
  tr.appendChild(document.createElement('td')).textContent = 'Total budget:';
  tr.appendChild(document.createElement('td'))
    .appendChild(renderCurrency(totalBudget, 0));

  tr = table.appendChild(document.createElement('tr'));
  tr.appendChild(document.createElement('td')).textContent = 'Total available:';

  const lastCommitTime = deserializeDate(state.time);
  const totalSavedEl = tr.appendChild(document.createElement('td'))
    .appendChild(document.createElement('span'));
  totalSavedEl.classList.add('currency');
  totalSavedEl.id = generateNewId();
  const updateTotalSavedCell = synchronous => {
    if (!synchronous && !document.getElementById(totalSavedEl.id))
      clearInterval(timer);
    const value = totalSavedValue + rateInDollarsPerMs(totalSavedRate) * (Date.now() - lastCommitTime)
    totalSavedEl.textContent = formatCurrency(value, 0);
  };
  updateTotalSavedCell(true);
  let timer = setInterval(updateTotalSavedCell, 1000);

  return totalsSection;
}

export function renderCurrency(amount: Currency, decimals = 2) {
  const el = document.createElement('span');
  el.classList.add('currency')
  el.textContent = formatCurrency(amount, decimals);
  return el;
}

export function renderList(list: List) {
  const listEl = document.createElement('div');
  listEl.id = 'current-list';
  domDataAttachments.set(listEl, list);
  listEl.classList.add('list');

  const stickyEl = listEl.appendChild(document.createElement('div'));
  stickyEl.classList.add('list-sticky-area');

  // Squirrel graphic
  stickyEl.appendChild(renderSquirrelGraphic());

  // Mobile top menu
  stickyEl.appendChild(renderMobileTopMenuBar());

  // List header
  const listHeaderEl = stickyEl.appendChild(document.createElement('div'));
  listHeaderEl.classList.add('list-header');

  // Header name section
  const listNameSection = listHeaderEl.appendChild(document.createElement('div'));
  listNameSection.classList.add('list-name');

  // Name heading
  const heading = listNameSection.appendChild(document.createElement('h1'));
  heading.id = 'list-heading';
  heading.classList.add('list-heading')
  makeEditable(heading, {
    read: () => getList(list.id).name,
    write: value => addUserAction({ type: 'ListSetName', listId: list.id, newName: value }),
    requiresRender: false
  });

  // Header info section
  const infoEl = listHeaderEl.appendChild(document.createElement('div'));
  infoEl.classList.add('list-info');

  // Allocated
  const allocatedEl = infoEl.appendChild(document.createElement('div'));
  allocatedEl.classList.add('list-allocated');

  // Allocated Amount
  const allocatedAmountEl = allocatedEl.appendChild(document.createElement('div'));
  allocatedAmountEl.classList.add('allocated-amount');
  makeEditable(allocatedAmountEl, {
    read: () => formatCurrency(getList(list.id).budget.dollars),
    write: v => addUserAction({ type: 'ListSetBudget', listId: list.id, budget: { dollars: parseNonNegativeCurrency(v), unit: '/month' } })
  });

  // Allocated Unit
  const allocationUnitEl = allocatedEl.appendChild(document.createElement('div'));
  allocationUnitEl.classList.add('allocated-unit');
  allocationUnitEl.textContent = list.budget.unit;

  // Kitty
  if (list.kitty.value || list.kitty.rate) {
    const overflowEl = infoEl.appendChild(document.createElement('span'));
    overflowEl.classList.add('list-overflow');
    if (list.kitty.value >= 0) {
      overflowEl.appendChild(renderLinearAmount(list.kitty));
      overflowEl.classList.remove('debt');
    } else {
      overflowEl.appendChild(renderLinearAmount({
        value: -list.kitty.value,
        rate: -list.kitty.rate
      }));
      overflowEl.classList.add('debt');
    }
  }

  // Menu
  listHeaderEl.appendChild(renderListMenu())

  // Purchase history
  const historyItemsEl = listEl.appendChild(document.createElement('ol'));
  historyItemsEl.classList.add('purchase-history');
  for (const item of list.purchaseHistory) {
    historyItemsEl.appendChild(renderHistoryItem(item));
  }

  // Items
  const itemsEl = listEl.appendChild(document.createElement('ol'));
  itemsEl.classList.add('items-list');
  for (const item of list.items) {
    itemsEl.appendChild(renderItem(item));
  }

  const addItemEl = listEl.appendChild(document.createElement('button'));
  addItemEl.classList.add('add-item', 'svg-button');
  addItemEl.addEventListener('click', addItemClick);
  addItemEl.appendChild(renderPlusSvg());

  return listEl;
}

export function getList(id: ListId) {
  return g.snapshot.lists.find(l => l.id === id) ?? unexpected();
}

function getItem(id: ItemId) {
  for (const list of g.snapshot.lists)
    for (const item of list.items)
      if (item.id === id) return item;
  return unexpected();
}

function unexpected(): never {
  throw new Error('Unexpected');
}

export function renderMobileTopMenuBar() {
  const mobileTopMenuEl = document.createElement('div');
  mobileTopMenuEl.id = 'mobile-top-menu';
  mobileTopMenuEl.addEventListener('click', () => {
    const page = document.getElementById('page');
    if (page.classList.contains('mobile-nav-showing')) {
      page.classList.remove('mobile-nav-showing');
    } else {
      page.classList.add('mobile-nav-showing');
    }
  });

  const menuButton = mobileTopMenuEl.appendChild(document.createElement('button'));
  menuButton.className = 'mobile-top-menu-button';
  menuButton.appendChild(createMobileNavMenuButtonSvg());

  return mobileTopMenuEl;
}

export function renderListMenu() {
  return renderMenu(menu => {
    menu.setIcon(createMenuButtonSvg());

    const listInject = menu.newItem();
    listInject.textContent = 'Inject money';
    listInject.addEventListener('click', injectMoneyClick);

    const addItem = menu.newItem();
    addItem.textContent = 'Add item';
    addItem.addEventListener('click', addItemClick);

    const deleteList = menu.newItem();
    deleteList.textContent = 'Delete list';
    deleteList.addEventListener('click', deleteListClick);
    deleteList.style.color = '#611';
  })
}

function renderItem(item: Item) {
  const itemEl = document.createElement('li');
  domDataAttachments.set(itemEl, item);
  itemEl.classList.add('item');
  if (item.price > 0 && item.saved.value >= item.price)
    itemEl.classList.add('afforded')
  if (item.saved.value > 0 && item.saved.value < item.price)
    itemEl.classList.add('partial-progress')
  if (item.saved.rate)
    itemEl.classList.add('active-progress');
  if (!item.price || item.expectedDate == 'never')
    itemEl.classList.add('no-eta');

  itemEl.draggable = true;
  itemEl.addEventListener('drag', itemDrag);
  itemEl.addEventListener('dragover', itemDragOver);
  itemEl.addEventListener('drop', itemDrop);
  itemEl.addEventListener('dragenter', itemDragEnter);
  itemEl.addEventListener('dragleave', itemDragLeave);
  itemEl.addEventListener('dragstart', itemDragStart);
  itemEl.addEventListener('dragend', itemDragEnd);

  // The outer element acts as the drag target when reordering. The inner
  // element is the thing with the border around it
  const itemInnerEl = itemEl.appendChild(document.createElement('div'));
  itemInnerEl.classList.add('item-inner');

  createItemBackground(item, itemInnerEl);

  // Item Name
  const nameSectionEl = itemInnerEl.appendChild(document.createElement('div'));
  nameSectionEl.classList.add('name-section');
  const nameEl = nameSectionEl.appendChild(document.createElement('div'));
  nameEl.classList.add('item-name');
  makeEditable(nameEl, {
    read: () => getItem(item.id).name,
    write: name => addUserAction({ type: 'ItemSetName', itemId: item.id, name }),
    requiresRender: false,
  });

  // Item note
  if (item.note) {
    const noteEl = nameSectionEl.appendChild(document.createElement('div'));
    noteEl.classList.add('item-note');
    noteEl.innerHTML = convertUrlsToLinks(item.note);
  }

  // Item Saved
  const savedSectionEl = itemInnerEl.appendChild(document.createElement('div'));
  savedSectionEl.classList.add('saved-section');
  const savedEl = savedSectionEl.appendChild(document.createElement('span'));
  savedEl.classList.add('currency');
  savedEl.classList.add('saved');
  savedEl.appendChild(renderLinearAmount(item.saved));

  // Item Info section
  const infoSectionEl = itemInnerEl.appendChild(document.createElement('div'));
  infoSectionEl.classList.add('info-section');

  // Item Price
  const priceEl = infoSectionEl.appendChild(document.createElement('span'));
  makeEditable(priceEl, {
    read: () => formatCurrency(getItem(item.id).price),
    write: v => addUserAction({
      type: 'ItemSetPrice',
      itemId: item.id,
      price: parseNonNegativeCurrency(v)
    })
  });
  priceEl.classList.add('currency');
  priceEl.classList.add('price');

  // Item ETA
  const etaEl = infoSectionEl.appendChild(document.createElement('span'));
  etaEl.classList.add('eta');
  const etaStr = item.expectedDate
    ? formatDate(deserializeDate(item.expectedDate))
    : 'Ready';
  etaEl.appendChild(document.createTextNode(etaStr));

  const buttonControlsEl = itemInnerEl.appendChild(document.createElement('div'));
  buttonControlsEl.classList.add('button-controls');

  // Item menu
  itemInnerEl.appendChild(createItemMenu(item));

  return itemEl;
}

function createItemMenu(item: Item) {
  return renderMenu(menu => {
    menu.setIcon(createMenuButtonSvg());

    // Purchase
    const purchaseItem = menu.newItem();
    purchaseItem.textContent = 'Purchased';
    purchaseItem.addEventListener('click', purchaseItemClick);
    const smiley = purchaseItem.appendChild(createSmileySvg())
    smiley.style.display = 'inline';
    smiley.style.marginLeft = '7px';
    smiley.style.marginBottom = '-2px';
    smiley.style.opacity = '0.5';
    smiley.setAttribute('width', '16');
    smiley.setAttribute('height', '16');

    // Edit note
    const editNote = menu.newItem();
    editNote.textContent = `${item.note ? 'Edit' : 'Add'} note`;
    editNote.addEventListener('click', editItemNoteClick);

    // Redistribute
    const redistribute = menu.newItem();
    redistribute.textContent = `Redistribute $${formatCurrency(item.saved.value)}`;
    redistribute.addEventListener('click', redistributeItemClick);

    // Delete
    const deleteItem = menu.newItem();
    if (item.saved.value >= 1) {
      deleteItem.textContent = `Delete ${item.name} (recover $${formatCurrency(item.saved.value, 0)})`;
    } else {
      deleteItem.textContent = `Delete ${item.name}`;
    }
    deleteItem.style.color = '#611';
    deleteItem.addEventListener('click', deleteItemClick);
  })
}

function renderHistoryItem(item: PurchaseHistoryItem) {
  const historyItemEl = document.createElement('li');

  domDataAttachments.set(historyItemEl, item);
  historyItemEl.classList.add('history-item');

  const historyItemInnerEl = historyItemEl.appendChild(document.createElement('div'));
  historyItemInnerEl.classList.add('item-inner');

  // Name
  const nameEl = historyItemInnerEl.appendChild(document.createElement('div'));
  nameEl.classList.add('item-name');
  nameEl.textContent = item.name;

  // Smiley
  historyItemInnerEl.appendChild(createSmileySvg());

  // Price
  const priceEl = historyItemInnerEl.appendChild(document.createElement('div'));
  priceEl.classList.add('currency');
  priceEl.classList.add('price');
  priceEl.textContent = formatCurrency(item.price);

  return historyItemEl;
}

function renderLinearAmount(amount: LinearAmount) {
  if (!amount.rate) {
    const amountSpan = document.createElement('span');
    amountSpan.classList.add('money');

    const mainAmount = amountSpan.appendChild(document.createElement('span'));
    mainAmount.classList.add('main-amount');
    mainAmount.textContent = formatCurrency(amount.value);

    return amountSpan;
  }

  const amountSpan = document.createElement('span');
  amountSpan.id = generateNewId();
  amountSpan.classList.add('money');

  const mainAmount = amountSpan.appendChild(document.createElement('span'));
  mainAmount.classList.add('main-amount');
  const subCents = amountSpan.appendChild(document.createElement('span'));
  subCents.classList.add('sub-cents');
  let executingFromTimer = false;
  const update = () => {
    // Check if element is removed
    if (executingFromTimer && !document.getElementById(amountSpan.id))
      return clearInterval(timer);
    const value = amount.value + rateInDollarsPerMs(amount.rate) * (Date.now() - g.lastCommitTime);
    const s = value.toFixed(4)
    mainAmount.textContent = s.slice(0, s.length - 2);
    subCents.textContent = s.slice(-2);
  }
  update();
  executingFromTimer = true;
  // The amount of time it takes to tick 100th of 1 cent
  const interval = 86400000 / (amount.rate * 10000);
  const timer = setInterval(update, interval)

  return amountSpan;
}

function createItemBackground(item: Item, itemEl: HTMLElement) {
  const amount = item.saved;
  // This function creates the moving background div to indicate progress, which
  // only applies
  if (amount.rate || (amount.value > 0 && amount.value < item.price)) {
    itemEl.id = generateNewId();
    let timer;
    const update = (synchronous) => {
      //if (global.isEditing) return;
      if (!synchronous && !document.getElementById(itemEl.id))
        return clearInterval(timer);
      const value = amount.value + rateInDollarsPerMs(amount.rate) * (Date.now() - g.lastCommitTime);
      const percent = (value / item.price) * 100;
      const color1 = amount.rate ? '#afd9ea' : '#dddddd';
      const color2 = amount.rate ? '#e1ecf1' : '#eaeaea';
      itemEl.style.background = `linear-gradient(90deg, ${color1} ${percent}%, ${color2} ${percent}%)`;
    }

    update(true);

    if (amount.rate) {
      // Once a second shouldn't be to taxing, and it's probably fast enough for
      // most real-world savings
      timer = setInterval(update, g.debugMode ? 100 : 1000)
    }
  }
}



function finishedUserInteraction(requiresRender = true) {
  updateState();
  save();
  if (requiresRender) render();
}

// Updates (projects) the state to the latest projected values and sets a
// timeout to repeat automatically the next time that the state needs to change
function updateState() {
  console.log('Update state');
  const toTime = Date.now();

  // Need at least one list to render
  if (g.snapshot.lists.length < 1) {
    doAction({ type: 'ListNew', name: 'Wish list' });
  }

  g.snapshot = projection(g.snapshot, toTime);

  g.nextNonlinearity = deserializeDate(g.snapshot.nextNonlinearity);
  g.lastCommitTime = toTime;

  if (g.nextNonlinearity) {
    let timeoutPeriod = g.nextNonlinearity - Date.now();
    console.log(`Next nonlinearity in ${timeoutPeriod/1000}s`)

    g.nextNonLinearityTimer && clearTimeout(g.nextNonLinearityTimer);
    if (timeoutPeriod > 2147483647)
      timeoutPeriod = 2147483647
    if (timeoutPeriod < 1)
      timeoutPeriod = 1;
    g.nextNonLinearityTimer = setTimeout(() => {
      if (g.isEditing || g.dialogBackgroundEl) {
        console.log('Not updating at nonlinearity because user is busy editing')
        return;
      }
      console.log('Updating at nonlinearity', formatDate(Date.now()))
      updateState();
      render();
    }, timeoutPeriod)
  }
}

// Projects the waterfall model (money overflowing from one item to the next in
// a waterfall fashion) to the future time `toTime`
function projection(state: Snapshot, toTime: Timestamp): Snapshot {
  return produce(state, state => mutatingProjection(state, toTime));
}

// Same as `projection` but does in-place mutations
function mutatingProjection(state: Snapshot, toTime: Timestamp) {
  state.time ??= serializeDate(toTime);

  const lastCommitTime = deserializeDate(state.time);
  let timeOfNextNonlinearity = null;

  for (const list of state.lists) {
    list.name ??= 'Wish list';
    list.budget ??= { dollars: 0, unit: '/month' };
    list.kitty ??= { value: 0, rate: 0 };
    list.items ??= [];
    list.purchaseHistory ??= [];
    console.assert(!!list.id);

    const allocatedRate = getAllocatedRate(list.budget);

    // We essentially iterate the time cursor forwards from the last commit time to the newTime
    let timeCursor = lastCommitTime;

    // The amount of money we have left over at `timeCursor`
    let remainingMoneyToAllocate = list.kitty.value + rateInDollarsPerMs(allocatedRate) * (toTime - lastCommitTime);

    // Rate of change of remainingMoneyToAllocate at `timeCursor`, which
    // eventually gets attributed to the kitty bucket
    let overflowRate = allocatedRate;

    // Are we in debt?
    let debt = 0;
    let debtRate = 0;
    if (remainingMoneyToAllocate < 0) {
      // The money isn't available to allocate to further items, so we move it
      // to the "debt" variable, which we'll put back in the kitty later
      debt = -remainingMoneyToAllocate;
      debtRate = -overflowRate;
      remainingMoneyToAllocate = 0;
      overflowRate = 0;

      // How long it will take ot pay off the debt
      timeCursor += allocatedRate ? debt / rateInDollarsPerMs(allocatedRate) : Infinity;

      // The next non-linearity corresponds to when the debt is paid
      if (!timeOfNextNonlinearity || timeCursor < timeOfNextNonlinearity)
        timeOfNextNonlinearity = timeCursor;
    }

    // A cascading waterfall where we allocate the new money down the list
    for (const item of list.items) {
      item.name ??= 'Item';
      item.price ??= 0;
      item.saved ??= { value: 0, rate: 0 };
      console.assert(!!item.id);

      // Remaining item cost at the time of last commit
      const remainingCost = item.price - item.saved.value;

      // Project when we will have saved enough for this item
      timeCursor += allocatedRate ? remainingCost / rateInDollarsPerMs(allocatedRate) : Infinity;

      // Do we have enough money yet to cover it now?
      if (remainingMoneyToAllocate >= remainingCost) {
        remainingMoneyToAllocate -= remainingCost; // For the rare case of a price reduction, we can add back the money
        item.saved.value = item.price;
        item.saved.rate = 0;
        item.expectedDate = null;
      } else {
        // Else we don't have enough money yet, so all the remaining money goes
        // to the item. A special case is that we have no remaining money.
        item.saved.value += remainingMoneyToAllocate;
        item.saved.rate = overflowRate;
        remainingMoneyToAllocate = 0;
        overflowRate = 0;

        // The time cursor is the projected date when the remaining cost of the
        // item will be paid off. The next nonlinearity is the earliest future
        // time at which an item will be paid off.
        if (!timeOfNextNonlinearity || timeCursor < timeOfNextNonlinearity)
          timeOfNextNonlinearity = timeCursor;

        item.expectedDate = serializeDate(timeCursor);
      }
    }

    // If there's still money left over, it goes into the kitty
    list.kitty.value = remainingMoneyToAllocate - debt;
    list.kitty.rate = overflowRate - debtRate;
  }

  state.time = serializeDate(toTime);
  state.nextNonlinearity = timeOfNextNonlinearity
    ? serializeDate(timeOfNextNonlinearity)
    : null;
}

function deleteItemClick(event) {
  const item = domDataAttachments.get(event.target.closest(".item"));

  addUserAction({ type: 'ItemDelete', itemId: item.id });

  finishedUserInteraction();
}

function redistributeItemClick(event) {

  const item = domDataAttachments.get(event.target.closest(".item"));

  addUserAction({
    type: 'ItemRedistributeMoney',
    itemId: item.id
  });

  finishedUserInteraction();
}

function editItemNoteClick(event) {
  updateState();

  const item = domDataAttachments.get(event.target.closest(".item")) as Item;

  const dialogContentEl = document.createElement('div');
  dialogContentEl.classList.add('edit-note-dialog');

  const noteInput = dialogContentEl.appendChild(document.createElement('input'));
  noteInput.classList.add('note');
  noteInput.value = item.note ?? '';

  noteInput.addEventListener('keyup', e => e.code === 'Enter' && apply());

  showDialog('Add note for ' + item.name, dialogContentEl, [{
    text: 'Cancel',
    action: hideDialog
  }, {
    text: 'Ok',
    classes: ['primary'],
    action: apply
  }]);

  noteInput.focus();
  noteInput.select();

  function apply() {
    addUserAction({
      type: 'ItemSetNote',
      itemId: item.id,
      note: noteInput.value
    });

    finishedUserInteraction();
  }
}

function purchaseItemClick(event) {
  hideMenu();

  updateState();

  const item = domDataAttachments.get(event.target.closest(".item")) as Item;

  const dialogContentEl = document.createElement('div');
  dialogContentEl.classList.add('purchase-dialog');

  const dl = dialogContentEl.appendChild(document.createElement('dl'));

  dl.appendChild(document.createElement('dt')).textContent = 'Estimated price';
  dl.appendChild(document.createElement('dd'))
    .appendChild(renderCurrency(item.price));

  dl.appendChild(document.createElement('dt')).textContent = 'Available';
  dl.appendChild(document.createElement('dd'))
    .appendChild(renderCurrency(item.saved.value));

  dl.appendChild(document.createElement('dt')).textContent = 'Actually paid';
  const actualPriceContainer = dl.appendChild(document.createElement('dd'))
    .appendChild(document.createElement('span'));
  actualPriceContainer.classList.add('currency');

  const actualPriceInput = actualPriceContainer.appendChild(document.createElement('input'));
  actualPriceInput.classList.add('currency-input');
  actualPriceInput.value = formatCurrency(item.saved.value || item.price);

  actualPriceInput.addEventListener('keyup', e => e.code === 'Enter' && apply());

  actualPriceInput.addEventListener('keyup', () => {
    if (isNaN(parseFloat(actualPriceInput.value)))
      return actualPriceInput.classList.add('invalid')

    actualPriceInput.classList.remove('invalid');

    const actualPrice = parseNonNegativeCurrency(actualPriceInput.value);

    const toAddToKitty = item.saved.value - actualPrice;
    if (toAddToKitty > 0.01) {
      noteEl.style.display = 'block';
      noteEl.textContent = `$ ${formatCurrency(toAddToKitty)} will be added back to the list`;
    } else if (toAddToKitty < -0.01) {
      noteEl.style.display = 'block';
      noteEl.textContent = `$ ${formatCurrency(-toAddToKitty)} will be removed from the kitty`;
    } else {
      noteEl.textContent = '';
    }
  })

  const noteEl = dialogContentEl.appendChild(document.createElement('p'));
  noteEl.classList.add('note');

  showDialog('Purchase ' + item.name, dialogContentEl, [{
    text: 'Cancel',
    action: hideDialog
  }, {
    text: 'Ok',
    classes: ['primary'],
    action: apply
  }]);

  actualPriceInput.focus();
  actualPriceInput.select();

  function apply() {
    const actualPrice = parseNonNegativeCurrency(actualPriceInput.value);

    addUserAction({
      type: 'ItemPurchase',
      itemId: item.id,
      actualPrice
    })

    finishedUserInteraction();
  }
}

function showDialog(title, content, buttons) {
  // Hide previous dialog
  hideDialog();

  g.dialogBackgroundEl = document.body.appendChild(document.createElement('div'));
  g.dialogBackgroundEl.classList.add('dialog-background');
  g.dialogBackgroundEl.addEventListener('mousedown', hideDialog);

  const dialogEl = g.dialogBackgroundEl.appendChild(document.createElement('div'));
  dialogEl.classList.add('dialog');
  dialogEl.addEventListener('mousedown', e => e.stopPropagation());

  const headerEl = dialogEl.appendChild(document.createElement('header'));
  headerEl.textContent = title;

  const bodyEl = dialogEl.appendChild(document.createElement('div'));
  bodyEl.classList.add('dialog-body');
  headerEl.textContent = title;

  const footerEl = dialogEl.appendChild(document.createElement('footer'));

  for (const button of buttons) {
    const buttonEl = footerEl.appendChild(document.createElement('button'));
    button.classes && buttonEl.classList.add(...button.classes);
    buttonEl.textContent = button.text;
    buttonEl.addEventListener('click', button.action);
  }

  bodyEl.appendChild(content);
}

function hideDialog() {
  g.dialogBackgroundEl && g.dialogBackgroundEl.remove();
  g.dialogBackgroundEl = undefined;
}

function addItemClick(event) {
  const list = domDataAttachments.get(event.target.closest(".list"));
  addUserAction({ type: 'ItemNew', listId: list.id });

  finishedUserInteraction();

  const itemNames = document.getElementsByClassName('item-name');
  const addedItemName = itemNames[itemNames.length - 1] as HTMLElement;
  selectAllInContentEditable(addedItemName);
}

// For debuggability, the rates are stored in dollars per day, but we need them
// in dollars per millisecond for most calculations
export function rateInDollarsPerMs(rate) {
  return rate / 86_400_000;
}

function formatDate(date) {
  if (date === Infinity)
    return 'Never';
  const d = new Date(date);
  const now = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const sameYear = d.getFullYear() === now.getFullYear()
  const sameDate = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && sameYear;
  if (sameDate) {
    return `${('0' + d.getHours()).slice(-2)}:${('0' + d.getMinutes()).slice(-2)}`
  } else if (sameYear) {
    return `${d.getDate()} ${months[d.getMonth()]}`;
  } else {
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  }
}

function serializeDate(date) {
  return date === Infinity
    ? 'never'
    : new Date(date).toISOString();
}

export function deserializeDate(date) {
  return date === 'never'
    ? Infinity
    : Date.parse(date)
}

function documentKeyDown(event) {
  // Ctrl+Z
  if (event.keyCode === 90 && event.ctrlKey) {
    if (event.shiftKey)
      redo();
    else
      undo();
    event.preventDefault();
    return false;
  }

  if (event.keyCode === 27) {
    hideDialog();
    hideMenu();
  }
}

function windowBlurEvent() {
  hideMenu();
}

function makeEditable(el: HTMLElement, { read, write, requiresRender = true }) {
  requiresRender ??= true;
  console.assert(read);
  console.assert(write);

  el.setAttribute('contentEditable', 'true');
  el.addEventListener('focus', focus)
  el.addEventListener('blur', blur)
  el.addEventListener('keypress', keypress)
  el.textContent = read();

  function focus() {
    beginEdit(el);
    el.textContent = read();
    selectAllInContentEditable(el);
  }

  function blur() {
    // Remove selection, if the text was selected
    window.getSelection().removeAllRanges();

    if (el.textContent !== read()) {
      updateState();
      write(el.textContent);
      el.textContent = read();
      endEdit(true, requiresRender);
    } else {
      endEdit(false);
    }
  }

  function keypress(event) {
    // Enter pressed
    if (event.keyCode === 13) {
      event.target.blur();
      event.preventDefault();
      return false;
    } else {
      continueEdit();
    }
  }
}

export function navListItemClick(event) {
  const list = (domDataAttachments.get(event.target) ?? domDataAttachments.get(event.target.closest(".nav-item"))) as List;

  const index = g.snapshot.lists.indexOf(list);
  g.currentListIndex = index;

  render();
}

function beginEdit(el) {
  updateState();

  g.isEditing = true;
  g.elementBeingEdited = el;
  // The nonlinearities don't update until we finish editing, so in case the
  // user leaves the edit in progress, we cancel after 1 minute of inactivity
  g.editingTimeout = setTimeout(editTimeout, 60000);
}

function continueEdit() {
  clearTimeout(g.editingTimeout);
  g.editingTimeout = setTimeout(editTimeout, 60000);
}

function editTimeout() {
  g.elementBeingEdited && g.elementBeingEdited.blur();
}

function endEdit(changed = true, requiresRender = true) {
  g.isEditing = false;
  g.elementBeingEdited = null;
  clearTimeout(g.editingTimeout);
  if (changed)
    finishedUserInteraction(requiresRender);
}

function newListClick() {
  let name = 'Wish list';
  let counter = 1;
  while (g.snapshot.lists.some(l => l.name === name))
    name = `Wish list ${++counter}`;

  addUserAction({ type: 'ListNew', name });

  g.currentListIndex = g.snapshot.lists.length - 1;

  finishedUserInteraction();

  const listHeading = document.getElementById('list-heading');
  selectAllInContentEditable(listHeading);
}

function renderPlusSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const r = 15;
  const margin = 2;
  const w = r * 2 + margin * 2;

  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('plus-svg');
  svg.setAttribute('viewBox', `${-r - margin} ${-r - margin} ${w} ${w}`);
  svg.setAttribute('width', w.toString());
  svg.setAttribute('height', w.toString());
  svg.style.display = 'block';

  const circle = svg.appendChild(document.createElementNS(ns, 'circle'));
  circle.setAttribute('r', r.toString());

  const plus = svg.appendChild(document.createElementNS(ns, 'path'));
  const s = r/2;
  plus.setAttribute('d', `M ${-s} 0 L ${s} 0 M 0 ${-s} L 0 ${s}`);

  return svg;
}

function itemDrag(event) {
  const item = domDataAttachments.get(event.target) ?? domDataAttachments.get(event.target.closest('.item'));
  g.draggingItem = item;
  event.dataTransfer.dropEffect = 'move';
}

function itemDragStart(event) {
  getItemElAtNode(event.target).classList.add('item-dragging');
}

function itemDragEnd(event) {
  getItemElAtNode(event.target).classList.remove('item-dragging');
}

function itemDragEnter(event) {
  if (!g.draggingItem) return;
  const itemEl = getItemElAtNode(event.target);
  if (domDataAttachments.get(itemEl) === g.draggingItem) return;
  itemEl.dragOverCount = (itemEl.dragOverCount ?? 0) + 1;
  if (itemEl.dragOverCount)
    itemEl.classList.add('item-drag-over');
}

function itemDragLeave(event) {
  if (!g.draggingItem) return;
  const itemEl = getItemElAtNode(event.target);
  if (domDataAttachments.get(itemEl) === g.draggingItem) return;
  itemEl.dragOverCount = (itemEl.dragOverCount ?? 0) - 1;
  if (!itemEl.dragOverCount)
    itemEl.classList.remove('item-drag-over');
}

function itemDragOver(event) {
  if (!g.draggingItem) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

function itemDrop(event) {
  event.preventDefault();

  const sourceItem = g.draggingItem;
  if (!sourceItem) return;
  g.draggingItem = undefined;

  event.dataTransfer.dropEffect = 'move';

  const list = domDataAttachments.get(event.target.closest('.list')) as List;
  const targetItem = (domDataAttachments.get(event.target) ?? domDataAttachments.get(event.target.closest('.item'))) as Item;

  addUserAction({
    type: 'ItemMove',
    itemId: sourceItem.id,
    targetListId: list.id,
    targetIndex: list.items.indexOf(targetItem),
  });

  finishedUserInteraction();
}

function getItemElAtNode(node) {
  if (domDataAttachments.get(node)) return node;
  return node.closest('.item');
}

function createSmileySvg() {
  const r = 13;
  const margin = 1;
  const w = r * 2 + margin * 2;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('smiley');
  svg.setAttribute('viewBox', `${-r - margin} ${-r - margin} ${w} ${w}`);
  svg.setAttribute('width', w.toString());
  svg.setAttribute('height', w.toString());
  // svg.style.display = 'block';

  const circle = svg.appendChild(document.createElementNS(svgNS, 'circle'));
  circle.classList.add('head');
  circle.setAttribute('r', r.toString());

  const leftEye = svg.appendChild(document.createElementNS(svgNS, 'circle'));
  leftEye.classList.add('eye');
  leftEye.setAttribute('r', '2');
  leftEye.setAttribute('cx', '-4.5');
  leftEye.setAttribute('cy', '-5');

  const rightEye = svg.appendChild(document.createElementNS(svgNS, 'circle'));
  rightEye.classList.add('eye');
  rightEye.setAttribute('r', '2');
  rightEye.setAttribute('cx', '4.5');
  rightEye.setAttribute('cy', '-5');

  const mouth = svg.appendChild(document.createElementNS(svgNS, 'path'));
  mouth.classList.add('mouth');
  const s = 8;
  mouth.setAttribute('d', `M ${-s},0 Q ${-s},${s} 0,${s} Q ${s},${s} ${s},0 Z`);
  // mouth.setAttribute('transform', 'translate(0 1)')

  return svg;
}

export function createReadyIndicatorSvg() {
  const r = 4;
  const margin = 1;
  const w = r * 2 + margin * 2;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('smiley');
  svg.setAttribute('viewBox', `${-r - margin} ${-r - margin} ${w} ${w}`);
  svg.setAttribute('width', w.toString());
  svg.setAttribute('height', w.toString());
  svg.style.display = 'block';

  const circle = svg.appendChild(document.createElementNS(svgNS, 'circle'));
  circle.setAttribute('r', r.toString());

  return svg;
}

function generateNewId() {
  g.idCounter = (g.idCounter ?? 0) + 1;
  return `id${g.idCounter}`;
}

function createMenuButtonSvg() {
  const r = 1.5;
  const margin = 1;
  const pitch = r * 4;
  const h = r * 2 + pitch * 2 + margin * 2;
  const w = h; //r * 2 + margin * 2;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('menu-glyph');
  svg.setAttribute('viewBox', `${-w/2} ${-h/2} ${w} ${h}`);
  svg.setAttribute('width', w.toString());
  svg.setAttribute('height', h.toString());
  svg.style.display = 'block';

  for (let i = -1; i <= 1; i++) {
    const circle = svg.appendChild(document.createElementNS(svgNS, 'circle'));
    circle.setAttribute('cy', (i * pitch).toString());
    circle.setAttribute('r', r.toString());
  }

  return svg;
}

function renderMenu(content: (menu: { setIcon(icon: Element): void, newItem(): HTMLElement }) => void) {
  const menuContainerEl = document.createElement('div');
  menuContainerEl.classList.add('menu-container');

  const menuBodyContainerEl = menuContainerEl.appendChild(document.createElement('div'));
  menuBodyContainerEl.classList.add('menu-body');
  menuBodyContainerEl.addEventListener('mousedown', e => e.stopPropagation());

  const menuItemsEl = menuBodyContainerEl.appendChild(document.createElement('ul'));
  menuItemsEl.classList.add('menu-items');

  const menuButtonEl = menuContainerEl.appendChild(document.createElement('button'));
  menuButtonEl.classList.add('menu-button');
  menuButtonEl.addEventListener('mousedown', e => e.stopPropagation());
  menuButtonEl.addEventListener('click', menuButtonClick);

  content({
    setIcon: icon => menuButtonEl.appendChild(icon),
    newItem(): HTMLElement {
      const menuItemEl = menuItemsEl.appendChild(document.createElement('li'));
      menuItemEl.classList.add('menu-item');
      return menuItemEl;
    }
  });

  return menuContainerEl;
}

function menuButtonClick(event) {
  toggleMenu(event.target.closest('.menu-container'));
}

function toggleMenu(menu) {
  const menuBody = menu.getElementsByClassName('menu-body')[0];
  if (menuBody.style.display === 'block') {
    g.showingMenu = undefined;
    menuBody.style.display = 'none';
  } else {
    hideMenu();
    g.showingMenu = menu;
    menuBody.style.display = 'block';
  }
}

function deleteListClick(event) {
  const list = domDataAttachments.get(event.target.closest('.list'));

  addUserAction({ type: 'ListDelete', listId: list.id })
  g.currentListIndex--;

  finishedUserInteraction();
}

function injectMoneyClick(event) {
  hideMenu();

  updateState();

  const list = domDataAttachments.get(event.target.closest('.list'));

  const dialogContentEl = document.createElement('div');

  const dl = dialogContentEl.appendChild(document.createElement('dl'));

  dl.appendChild(document.createElement('dt')).textContent = 'Amount';
  const amountContainer = dl.appendChild(document.createElement('dd'))
    .appendChild(document.createElement('span'));
  amountContainer.classList.add('currency');

  const amountInput = amountContainer.appendChild(document.createElement('input'));
  amountInput.classList.add('currency-input');
  amountInput.value = formatCurrency(0);

  amountInput.addEventListener('keyup', e => e.code === 'Enter' && apply());

  amountInput.addEventListener('keyup', () => {
    if (isNaN(parseFloat(amountInput.value)))
      amountInput.classList.add('invalid')
    else
      amountInput.classList.remove('invalid');
  })

  showDialog(`Add money to ${list.name}`, dialogContentEl, [{
    text: 'Cancel',
    action: hideDialog
  }, {
    text: 'Inject',
    action: apply
  }]);

  amountInput.focus();
  amountInput.select();

  function apply() {
    const amount = parseCurrency(amountInput.value);

    addUserAction({ type: 'ListInjectMoney', listId: list.id, amount });

    finishedUserInteraction();
  }
}

function documentMouseDown() {
  hideMenu();
}

function hideMenu() {
  if (g.showingMenu) {
    const menuBody = g.showingMenu.getElementsByClassName('menu-body')[0] as HTMLElement;
    menuBody.style.display = 'none';
    g.showingMenu = undefined;
  }
}

// https://stackoverflow.com/a/8943487
function convertUrlsToLinks(text) {
  const urlRegex =/(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
  return text.replace(urlRegex, function(url) {
    return '<a href="' + url + '" target="_blank">' + url + '</a>';
  });
}

function apiRequest(cmd, data): Promise<any> {
  return new Promise((resolve, reject) => {
    console.log(`-> ${cmd}`);
    const req = new XMLHttpRequest();
    req.open('post', 'api.php', true);
    req.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
    req.onload = () => {
      try {
        if (req.status >= 200 && req.status < 300) {
          console.log(`<- ${cmd}`);
          resolve(JSON.parse(req.responseText));
        } else {
          console.error(`x- ${cmd}`);
          reject('API error');
        }
      } catch (e) {
        console.error(e);
        console.error(`x- ${cmd}`);
        reject('API error');
      }
    };
    req.onerror = e => {
      console.error(`x- ${cmd}`);
      console.error(e);
      reject('API error');
    };
    req.send(JSON.stringify({ cmd, data }));
  })
}

export function signInClick() {
  const dialogContentEl = document.createElement('div');
  dialogContentEl.classList.add('login-dialog');

  const userEmailLabel = dialogContentEl.appendChild(document.createElement('label'));
  userEmailLabel.setAttribute('for', 'email');
  userEmailLabel.textContent = 'Email';

  const userEmailEl = dialogContentEl.appendChild(document.createElement('input'));
  userEmailEl.setAttribute('type', 'email');
  userEmailEl.setAttribute('name', 'email');
  userEmailEl.classList.add('email');
  userEmailEl.value = '';

  const userPasswordLabel = dialogContentEl.appendChild(document.createElement('label'));
  userPasswordLabel.setAttribute('for', 'password');
  userPasswordLabel.textContent = 'Password';

  const userPasswordEl = dialogContentEl.appendChild(document.createElement('input'));
  userPasswordEl.setAttribute('type', 'password');
  userPasswordEl.setAttribute('name', 'password');
  userPasswordEl.classList.add('password');
  userPasswordEl.value = '';

  const errorNotice = dialogContentEl.appendChild(document.createElement('div'));
  errorNotice.className = 'login-error';

  userPasswordEl.addEventListener('keyup', e => e.code === 'Enter' && apply());

  showDialog('Sign in', dialogContentEl, [{
    text: 'Cancel',
    action: hideDialog
  }, {
    text: 'Ok',
    classes: ['primary'],
    action: apply
  }]);

  userEmailEl.focus();
  userEmailEl.select();

  async function apply() {
    const email = userEmailEl.value;
    const password = userPasswordEl.value;

    const result = await apiRequest('login', { email, password });
    if (result.success) {
      g.mode = 'online';
      // When we sign in, we STOP using 'squirrel-away-state' and instead use
      // 'squirrel-away-online-state'. We preserve the original as a completely
      // separate state. The use case here is that your friend logs into your
      // account -- you don't want your friend's state to be merged into yours.
      g.state = parseState(localStorage.getItem('squirrel-away-online-state'));
      g.state = mergeStates(g.state, result.state);
      g.userInfo = result.userInfo;
      localStorage.setItem('user-info', JSON.stringify(g.userInfo));

      finishedUserInteraction();
    } else {
      errorNotice.textContent = 'Failed to log in: ' + (result.reason ?? '')
    }
  }
}

function mergeStates(state1: StateBlobStructure, state2: StateBlobStructure): StateBlobStructure {
  const actions = mergeHistories(state1.actions, state2.actions);

  // An optimization for fast-forward merges (common case)
  if (actions === state1.actions) return state1;
  if (actions === state2.actions) return state2;

  return {
    ...reduceActions(actions),
    actions
  }
}

export function signUpClick() {
  const dialogContentEl = document.createElement('div');
  dialogContentEl.classList.add('sign-up-dialog');

  const nameLabel = dialogContentEl.appendChild(document.createElement('label'));
  nameLabel.setAttribute('for', 'name');
  nameLabel.textContent = 'Your name';

  const nameEl = dialogContentEl.appendChild(document.createElement('input'));
  nameEl.setAttribute('type', 'text');
  nameEl.setAttribute('name', 'name');
  nameEl.classList.add('name');
  nameEl.value = '';

  const userEmailLabel = dialogContentEl.appendChild(document.createElement('label'));
  userEmailLabel.setAttribute('for', 'email');
  userEmailLabel.textContent = 'Email';

  const userEmailEl = dialogContentEl.appendChild(document.createElement('input'));
  userEmailEl.setAttribute('type', 'email');
  userEmailEl.setAttribute('name', 'email');
  userEmailEl.classList.add('email');
  userEmailEl.value = '';

  const userPasswordLabel = dialogContentEl.appendChild(document.createElement('label'));
  userPasswordLabel.setAttribute('for', 'password');
  userPasswordLabel.textContent = 'Password';

  const userPasswordEl = dialogContentEl.appendChild(document.createElement('input'));
  userPasswordEl.setAttribute('type', 'password');
  userPasswordEl.setAttribute('name', 'password');
  userPasswordEl.classList.add('password');
  userPasswordEl.value = '';

  const errorNotice = dialogContentEl.appendChild(document.createElement('div'));
  errorNotice.className = 'login-error';

  userPasswordEl.addEventListener('keyup', e => e.code === 'Enter' && apply());

  showDialog('New Account', dialogContentEl, [{
    text: 'Cancel',
    action: hideDialog
  }, {
    text: 'Ok',
    classes: ['primary'],
    action: apply
  }]);

  nameEl.focus();
  nameEl.select();

  async function apply() {
    const name = nameEl.value;
    const email = userEmailEl.value;
    const password = userPasswordEl.value;
    const state = g.state;

    const result = await apiRequest('new-account', { name, email, password, state });
    if (result.success) {
      g.mode = 'online';
      g.state = result.state;
      g.userInfo = result.userInfo;
      localStorage.setItem('squirrel-away-online-state', JSON.stringify(g.state));
      localStorage.setItem('user-info', JSON.stringify(g.userInfo));
      // The next time the user logs out, they won't see the state, so it's hopefully less confusing
      localStorage.removeItem('state');

      finishedUserInteraction();
    } else {
      errorNotice.textContent = 'Failed to sign up: ' + (result.reason ?? '')
    }
  }
}

function detectMode() {
  if (g.userInfo?.id) {
    g.mode = 'online';
  } else if (typeof require !== 'undefined') {
    g.mode = 'electron-local';
  } else {
    g.mode = 'web-local';
  }
}

export function hideMobileNav() {
  document.getElementById('page').classList.remove('mobile-nav-showing');
}

export async function signOutClick() {
  delete g.userInfo;
  localStorage && localStorage.removeItem('user-info');
  localStorage && localStorage.removeItem('squirrel-away-online-state');
  g.syncStatus = 'sync-pending';
  detectMode();
  await g.loadState();
  finishedUserInteraction();
}

function saveScrollPosition() {
  const list = document.getElementById('current-list');
  if (list) g.listScrollPosition = list.scrollTop;
}

function restoreScrollPosition() {
  // This is a hack to keep the user scrolled to the right location when the
  // page refreshes. Otherwise, whenever you add a new item, the scroll position
  // is lost and you go back up to the top.
  const list = document.getElementById('current-list');
  list.scrollTop = g.listScrollPosition;
}

function selectAllInContentEditable(el: HTMLElement) {
  el.focus();
  //document.execCommand('selectAll', false, null);

  setTimeout(selectRange, 1);
  selectRange();

  function selectRange(){
    // https://stackoverflow.com/a/3806004
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// https://stackoverflow.com/a/2117523
function uuidv4(): Uuid {
  return (([1e7] as any)+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

// Folds the action into the state and records it in the undo history
export function addUserAction(newAction: NewAction) {
  const action = doAction(newAction);

  g.undoHistory[g.undoIndex++] = action.id;
  // Any future history (for redo) becomes invalid at this point
  if (g.undoHistory.length > g.undoIndex)
    g.undoHistory = g.undoHistory.slice(0, g.undoIndex);
}

function doAction(newAction: NewAction) {
  const actionWithoutHash: ActionWithoutHash = {
    id: uuidv4(),
    time: serializeDate(Date.now()),
    ...newAction,
  };

  const action = Object.freeze({
    ...actionWithoutHash,
    hash: calculateActionHash(g.snapshot.hash, actionWithoutHash)
  }) as Action;

  g.snapshot = foldAction(g.snapshot, action, g.actions);
  g.actions.push(action);

  return action;
}

function calculateActionHash(prevActionHash: Md5Hash, action: ActionWithoutHash): Md5Hash {
  // The hash is like a git hash if "actions" are like commits. The hash allows
  // us to quickly merge two histories or determine if there's a conflict (a
  // fork in the history) -- see `mergeHistories`. Note that "JSON.stringify"
  // here is technically not correct since it's not guaranteed to produce a
  // canonical/deterministic output each time across different environments, but
  // in this case it's safe to produce a different hash for the same history
  // since it will just fall back to a full history merge (the hash is just used
  // as an optimization).
  const { hash, ...contentToHash } = action as Action;
  return md5Hash(JSON.stringify([prevActionHash, contentToHash]));
}

// Folds the effect of the given action into the given state, unless
// `skipEffect` is true, in which case the hash will be updated but no effect on
// the state lists. Note that the hash for the action must be correct.
function foldAction(
  snapshot: Snapshot,
  action: Action,
  prevActions: Iterable<Action>,
  skipEffect = false): Snapshot
{
  return produce(snapshot, snapshot => {
    // At this point, we already expect the hash to match
    console.assert(action.hash === calculateActionHash(snapshot.hash, action), 'Hash mismatch');

    // Incorporate hash into the state
    snapshot.hash = action.hash;

    if (skipEffect) {
      return;
    }

    const time = deserializeDate(action.time);
    mutatingProjection(snapshot, time);

    const findList = id => snapshot.lists.find(l => l.id === id);
    const findItem = id => {
      for (const list of snapshot.lists)
        for (const item of list.items)
          if (item.id === id) return { list, item };
    }

    switch (action.type) {
      case 'New': {
        snapshot.id = action.id;
        snapshot.time = action.time;
        snapshot.lists = [];
        break;
      }
      case 'MigrateState': {
        // Migrate from a pre-event-sourced state structure
        Object.assign(snapshot, deepClone(action.state));
        snapshot.time = action.time;
        break;
      }
      case 'ListNew': {
        snapshot.lists.push({ id: action.id,
          name: action.name,
          items: [],
          budget: { dollars: 0, unit: '/month' },
          kitty: { value: 0, rate: 0 },
          purchaseHistory: []
        });
        break;
      }
      case 'ListDelete': {
        const index = snapshot.lists.findIndex(list => list.id === action.listId);
        if (index != -1) snapshot.lists.splice(index, 1);
        break;
      }
      case 'ListSetName': {
        const list = findList(action.listId);
        if (list) list.name = action.newName;
        break;
      }
      case 'ListSetBudget': {
        const list = findList(action.listId);
        if (list) Object.assign(list.budget, action.budget);
        break;
      }
      case 'ListInjectMoney': {
        const list = findList(action.listId);
        if (list) list.kitty.value += action.amount;
        break;
      }
      case 'ItemNew': {
        findList(action.listId)?.items?.push({
          id: action.id,
          name: undefined,
          price: 0,
          saved: { value: 0, rate: 0 },
        });
        break;
      }
      case 'ItemMove': {
        const source = findItem(action.itemId);
        const targetList = findList(action.targetListId);
        if (!source || !targetList) break;

        const sourceIndex = source.list.items.indexOf(source.item);
        console.assert(sourceIndex != -1);
        const targetIndex = Math.max(Math.min(action.targetIndex, targetList.items.length - 1), 0);

        source.list.items.splice(sourceIndex, 1);
        targetList.items.splice(targetIndex, 0, source.item);
        break;
      }
      case 'ItemDelete': {
        const found = findItem(action.itemId);
        if (!found) break;
        const { item, list } = found;

        const index = list.items.indexOf(item);
        console.assert(index != -1);
        list.items.splice(index, 1);

        // Put the value back into the kitty
        list.kitty.value += item.saved.value;
        break;
      }
      case 'ItemSetName': {
        const item = findItem(action.itemId)?.item;
        if (item) item.name = action.name;
        break;
      }
      case 'ItemSetPrice': {
        const found = findItem(action.itemId);
        if (!found) break;
        const { item, list } = found;

        item.price = action.price;

        // Excess goes into the kitty
        if (action.price < item.saved.value) {
          list.kitty.value += item.saved.value - action.price;
          item.saved.value = action.price;
        }
        break;
      }
      case 'ItemSetNote': {
        const item = findItem(action.itemId)?.item;
        if (item) item.note = action.note;
        break;
      }
      case 'ItemPurchase': {
        const found = findItem(action.itemId);
        if (!found) break;
        const { list, item } = found;

        // Put all the money back into the kitty except which what was paid
        list.kitty.value += item.saved.value - action.actualPrice;

        list.purchaseHistory.push({
          id: item.id,
          name: item.name,
          priceEstimate: item.price,
          price: action.actualPrice,
          purchaseDate: action.time
        });

        list.items.splice(list.items.indexOf(item), 1);
        break;
      }
      case 'ItemRedistributeMoney': {
        const found = findItem(action.itemId);
        if (!found) break;
        const { list, item } = found;

        list.kitty.value += item.saved.value;
        item.saved.value = 0;
        break;
      }
      case 'Undo': {
        // To go back in time to undo the action, the easiest is to just
        // rebuild the state from scratch including the current undo action.
        return reduceActions([...prevActions, action]);
      }
      case 'Redo': {
        // As with 'Undo'
        return reduceActions([...prevActions, action]);
      }
    }

    // Run another projection just to update any side effects of the action. For
    // example, redistributing newly-available cash
    mutatingProjection(snapshot, time);
  })
}

// https://stackoverflow.com/a/33486055
function md5Hash(d: string): Md5Hash {var r = M(V(Y(X(d),8*d.length)));return r.toLowerCase()};function M(d){for(var _,m="0123456789ABCDEF",f="",r=0;r<d.length;r++)_=d.charCodeAt(r),f+=m.charAt(_>>>4&15)+m.charAt(15&_);return f}function X(d){for(var _=Array(d.length>>2),m=0;m<_.length;m++)_[m]=0;for(m=0;m<8*d.length;m+=8)_[m>>5]|=(255&d.charCodeAt(m/8))<<m%32;return _}function V(d){for(var _="",m=0;m<32*d.length;m+=8)_+=String.fromCharCode(d[m>>5]>>>m%32&255);return _}function Y(d,_){d[_>>5]|=128<<_%32,d[14+(_+64>>>9<<4)]=_;for(var m=1732584193,f=-271733879,r=-1732584194,i=271733878,n=0;n<d.length;n+=16){var h=m,t=f,g=r,e=i;f=md5_ii(f=md5_ii(f=md5_ii(f=md5_ii(f=md5_hh(f=md5_hh(f=md5_hh(f=md5_hh(f=md5_gg(f=md5_gg(f=md5_gg(f=md5_gg(f=md5_ff(f=md5_ff(f=md5_ff(f=md5_ff(f,r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+0],7,-680876936),f,r,d[n+1],12,-389564586),m,f,d[n+2],17,606105819),i,m,d[n+3],22,-1044525330),r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+4],7,-176418897),f,r,d[n+5],12,1200080426),m,f,d[n+6],17,-1473231341),i,m,d[n+7],22,-45705983),r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+8],7,1770035416),f,r,d[n+9],12,-1958414417),m,f,d[n+10],17,-42063),i,m,d[n+11],22,-1990404162),r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+12],7,1804603682),f,r,d[n+13],12,-40341101),m,f,d[n+14],17,-1502002290),i,m,d[n+15],22,1236535329),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+1],5,-165796510),f,r,d[n+6],9,-1069501632),m,f,d[n+11],14,643717713),i,m,d[n+0],20,-373897302),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+5],5,-701558691),f,r,d[n+10],9,38016083),m,f,d[n+15],14,-660478335),i,m,d[n+4],20,-405537848),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+9],5,568446438),f,r,d[n+14],9,-1019803690),m,f,d[n+3],14,-187363961),i,m,d[n+8],20,1163531501),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+13],5,-1444681467),f,r,d[n+2],9,-51403784),m,f,d[n+7],14,1735328473),i,m,d[n+12],20,-1926607734),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+5],4,-378558),f,r,d[n+8],11,-2022574463),m,f,d[n+11],16,1839030562),i,m,d[n+14],23,-35309556),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+1],4,-1530992060),f,r,d[n+4],11,1272893353),m,f,d[n+7],16,-155497632),i,m,d[n+10],23,-1094730640),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+13],4,681279174),f,r,d[n+0],11,-358537222),m,f,d[n+3],16,-722521979),i,m,d[n+6],23,76029189),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+9],4,-640364487),f,r,d[n+12],11,-421815835),m,f,d[n+15],16,530742520),i,m,d[n+2],23,-995338651),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+0],6,-198630844),f,r,d[n+7],10,1126891415),m,f,d[n+14],15,-1416354905),i,m,d[n+5],21,-57434055),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+12],6,1700485571),f,r,d[n+3],10,-1894986606),m,f,d[n+10],15,-1051523),i,m,d[n+1],21,-2054922799),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+8],6,1873313359),f,r,d[n+15],10,-30611744),m,f,d[n+6],15,-1560198380),i,m,d[n+13],21,1309151649),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+4],6,-145523070),f,r,d[n+11],10,-1120210379),m,f,d[n+2],15,718787259),i,m,d[n+9],21,-343485551),m=safe_add(m,h),f=safe_add(f,t),r=safe_add(r,g),i=safe_add(i,e)}return Array(m,f,r,i)}function md5_cmn(d,_,m,f,r,i){return safe_add(bit_rol(safe_add(safe_add(_,d),safe_add(f,i)),r),m)}function md5_ff(d,_,m,f,r,i,n){return md5_cmn(_&m|~_&f,d,_,r,i,n)}function md5_gg(d,_,m,f,r,i,n){return md5_cmn(_&f|m&~f,d,_,r,i,n)}function md5_hh(d,_,m,f,r,i,n){return md5_cmn(_^m^f,d,_,r,i,n)}function md5_ii(d,_,m,f,r,i,n){return md5_cmn(m^(_|~f),d,_,r,i,n)}function safe_add(d,_){var m=(65535&d)+(65535&_);return(d>>16)+(_>>16)+(m>>16)<<16|65535&m}function bit_rol(d,_){return d<<_|d>>>32-_}

// Build a new State from the given list of actions
function reduceActions(actions: Action[]): Snapshot {
  // We run a first look-ahead pass to tally all the undo/redo actions to see
  // which actions should not take be taken into effect.
  const skip = new Set();
  for (const action of actions) {
    if (action.type === 'Undo') {
      console.assert(!skip.has(action.actionIdToUndo));
      // The Undo action and the action being undone cancel each other out so we skip them both
      skip.add(action.id);
      skip.add(action.actionIdToUndo);
    } else if (action.type === 'Redo') {
      console.assert(skip.has(action.actionIdToRedo));
      skip.add(action.id);
      skip.delete(action.actionIdToRedo);
    }
  }

  return actions.reduce(
    ({ snapshot, actions }, action) => {
      snapshot = foldAction(snapshot, action, actions, skip.has(action.id));
      // For performance reasons, this reducer is not strictly pure, but the
      // mutation is local to this function (reduceActions)
      actions.push(action);
      return { snapshot, actions };
    },
    { snapshot: emptyState(), actions: new Array<Action>() }
  ).snapshot;
}

function emptyState(): Snapshot {
  return {
    // Note: these three fields get their initial value either from a `New`
    // action or a `MigrateState` action, which should be the first actions in
    // the history.
    id: '',
    time: serializeDate(0),
    nextNonlinearity: 'never',

    lists: [],
    hash: emptyHash
  }
}

function newState(): StateBlobStructure {
  const actionWithoutHash: ActionWithoutHash = {
    type: 'New',
    id: uuidv4(),
    time: serializeDate(Date.now()),
  };

  const action: Action = Object.freeze({
    ...actionWithoutHash,
    hash: calculateActionHash(emptyHash, actionWithoutHash)
  });

  const snapshot = foldAction(emptyState(), action, []);

  return {
    ...snapshot,
    actions: [action]
  }
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// TODO: Remove this at some point
function occasionallyRebuild() {
  setInterval(() => {
    // This is to prove to ourselves that the "actions" property of the state
    // contains all the necessary information to rebuild the latest state of all
    // the lists. I want this here because it'll cause bugs to surface earlier
    // rather than later if there's a problem building state from the actions.
    if (!g.dialogBackgroundEl && !g.isEditing && g.actions) {
      console.log('Rebuilding the list state from the actions')
      g.snapshot = reduceActions(g.actions);
      g.lastCommitTime = deserializeDate(g.snapshot.time);

      render();
    }
  }, 60_000);
}

function mergeHistories(...histories: StateHistory[]): StateHistory {
  if (histories.length < 2) return histories[0];

  const [history1, history2, ...rest] = histories;
  if (rest.length > 0) return mergeHistories(mergeHistories(history1, history2), ...rest);

  if (!history2) return history1;
  if (!history1) return history2;

  const history1Hash = historyHash(history1);
  const history2Hash = historyHash(history2);

  // Special case: if the hash is the same, the content is the same
  if (history1Hash === history2Hash) return history1;

  // Special case: if one state can do a fast-forward to reach the other state
  if (history1.some(a => a.hash === history2Hash)) return history1;
  if (history2.some(a => a.hash === history1Hash)) return history2;

  const itLeft = history1[Symbol.iterator]();
  const itRight = history2[Symbol.iterator]();

  let left = itLeft.next();
  let right = itRight.next();
  let newState = emptyState();
  let hash = emptyHash;
  const result: StateHistory = [];

  while (!left.done || !right.done) {
    let pickAction: Action;
    if (!left.done && !right.done && left.value.id === right.value.id) {
      // Consume both, since they're the same action (the most common case)
      pickAction = left.value;
      left = itLeft.next();
      right = itRight.next();
    } else if (!left.done && (right.done || left.value.time <= right.value.time)) {
      // The left "wins" because it's earlier (or we've run out right actions)
      pickAction = left.value;
      left = itLeft.next();
    } else {
      // The right "wins" because it has an earlier time than the left (or the left has run out of actions)
      pickAction = right.value;
      right = itRight.next();
    }

    // Make sure the hash is right
    hash = calculateActionHash(hash, pickAction);
    if (hash !== pickAction.hash) {
      pickAction = Object.freeze({ ...pickAction, hash });
    }
    hash = pickAction.hash;

    result.push(pickAction);
  }

  return result;
}

function historyHash(history: StateHistory) {
  return history[history.length - 1]?.hash ?? emptyHash;
}

// TODO: Remove this at some point
function upgradeStateFormat(state: StateBlobStructure): StateBlobStructure {
  if (!state) return state;
  // For backwards compatibility with states that weren't created using an
  // actions list, we need to set up an actions list that is equivalent to the
  // existing state.
  if (!state.actions) {
    const id = state.id;
    const time = state.time;
    const snapshot: Snapshot = {
      id: state.id,
      hash: state.hash,
      time: state.time,
      nextNonlinearity: state.nextNonlinearity,
      lists: state.lists.map(list => ({
        id: list.id ?? uuidv4(),
        name: list.name,
        budget: {
          dollars: list.budget.dollars,
          unit: list.budget.unit
        },
        kitty: {
          value: list.kitty.value,
          rate: list.kitty.rate
        },
        purchaseHistory: list.purchaseHistory.map(p => ({
          id: p.id ?? uuidv4(),
          name: p.name,
          priceEstimate: p.priceEstimate,
          price: p.price,
          purchaseDate: p.purchaseDate
        })),
        items: list.items.map(i => ({
          id: i.name ?? uuidv4(),
          price: i.price,
          saved: { value: i.saved.value, rate: i.saved.rate },
          note: i.note
        }))
      }))
    };

    const actions: Action[] = [{
      type: 'MigrateState',
      id,
      time,
      hash: '', // Will be populated by the fold
      state: snapshot
    }]

    const newState = reduceActions(actions);

    return {
      ...newState,
      actions
    }
  }
  return state;
}

async function synchronize(renderOnChange = true) {
  if (g.mode !== 'online') return;

  console.log('Synchronizing with localStorage');
  let state = g.state;

  // Synchronize with local storage first

  const local = parseState(localStorage.getItem('squirrel-away-online-state'));
  state = mergeStates(state, local);

  if (!sameState(state, local)) {
    console.log('Pushing state to local storage');
    localStorage.setItem('squirrel-away-online-state', JSON.stringify(state));
  }

  if (!sameState(state, g.state)) {
    console.log('Loading changes from local storage');
    g.state = state;
    g.lastCommitTime = deserializeDate(state.time);
    if (renderOnChange) render();
  }

  if (!state) {
    await syncWithServer();
  } else {
    // If we already have a state locally, we can afford not to block on the
    // server request. Mainly this is intended to improve startup time because
    // we can eagerly sync with localStorage first and then incorporate changes
    // from the server when they're available.
    syncWithServer();
  }
}

async function syncWithServer() {
  try {
    console.log('Synchronizing with server');

    const remote = upgradeStateFormat(await loadRemoteState());
    const state = mergeStates(g.state, remote);
    if (!sameState(state, remote)) {
      console.log('Pushing state to server');
      await saveRemoteState(state);
    }

    if (!sameState(state, g.state)) {
      console.log('Rendering changes from server');
      g.state = state;
      g.lastCommitTime = deserializeDate(state.time);
      g.syncStatus = 'sync-success';
      render();
    } else {
      console.log('No changes from server');

      if (g.syncStatus !== 'sync-success') {
        g.syncStatus = 'sync-success';
        render();
      }
    }
  } catch (e) {
    g.syncStatus = 'sync-failure';
    console.error(e);
    render();
  }
}

async function loadRemoteState() {
  const response = await apiRequest('load', { userId: g.userInfo.id });
  return response.success ? response.state : undefined;
}

async function saveRemoteState(state) {
  await apiRequest('save', { userId: g.userInfo.id, state });
}

function parseState(json) {
  return json && upgradeStateFormat(JSON.parse(json));
}

function sameState(state1: Snapshot, state2: Snapshot) {
  return state1.hash === state2.hash;
}

function createMobileNavMenuButtonSvg() {
  const thickness = 2;
  const margin = 1;
  const pitch = 5;
  const h = thickness + pitch * 2 + margin * 2;
  const w = h;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('nav-menu-glyph');
  svg.setAttribute('viewBox', `${-w/2} ${-h/2} ${w} ${h}`);
  svg.setAttribute('width', w.toString());
  svg.setAttribute('height', h.toString());
  svg.style.display = 'block';

  for (let i = -1; i <= 1; i++) {
    const line = svg.appendChild(document.createElementNS(svgNS, 'line'));
    line.setAttribute('x1', (-w/2 + margin).toString());
    line.setAttribute('x2', (+w/2 - margin).toString());
    line.setAttribute('y1', (i * pitch).toString());
    line.setAttribute('y2', (i * pitch).toString());
    line.setAttribute('stroke-width', thickness.toString());
  }

  return svg;
}

function renderSquirrelGraphic() {
  const internalX = 0;
  const internalY = 2;
  const internalSize = 100;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('squirrel-graphic');
  svg.setAttribute('viewBox', `${internalX} ${internalY} ${internalSize} ${internalSize}`);
  svg.setAttribute('width', '50');
  svg.setAttribute('height', '50');
  svg.style.display = 'block';

  const path = svg.appendChild(document.createElementNS(svgNS, 'path'));
  path.setAttribute('d', 'm 57.743013,29.127309 c -12.93795,0.179207 -22.347307,11.920556 -21.895807,24.86346 0.453995,13.014395 12.723204,19.422555 11.922584,33.151853 -0.252254,4.325777 -2.256285,9.132424 -8.96533,14.164208 17.743524,-2.957243 17.743524,-20.700777 17.743524,-35.487045 0,-18.265493 16.265304,-18.27202 22.707897,-8.660942 C 82.21312,36.458046 68.526468,28.977945 57.743013,29.127309 Z M 15.583664,51.653267 c -0.04923,-0.0018 -0.09976,0.0016 -0.151328,0.0098 -1.436303,0.228226 -1.15389,2.04243 -1.331342,4.755288 a 9.8298778,9.8298778 0 0 0 -2.870038,-0.428571 9.8298778,9.8298778 0 0 0 -9.829403,9.829983 9.8298778,9.8298778 0 0 0 9.829403,9.82998 9.8298778,9.8298778 0 0 0 9.829981,-9.82998 9.8298778,9.8298778 0 0 0 -2.327682,-6.351744 c -1.192858,-3.122049 -1.645077,-7.758565 -3.149591,-7.81477 z M 9.2169048,62.582976 a 1.9162314,1.9162314 0 0 1 1.9164392,1.916439 1.9162314,1.9162314 0 0 1 -1.9164392,1.916439 1.9162314,1.9162314 0 0 1 -1.9164393,-1.916439 1.9162314,1.9162314 0 0 1 1.9164393,-1.916439 z m 21.3494092,6.616278 a 16.264895,16.264895 0 0 0 -16.264896,16.264897 16.264895,16.264895 0 0 0 9.497867,14.789739 1.4114845,1.4114845 0 0 0 -0.01155,0.18136 1.4114845,1.4114845 0 0 0 1.41105,1.41162 1.4114845,1.4114845 0 0 0 1.196185,-0.66191 16.264895,16.264895 0 0 0 4.171345,0.54409 A 16.264895,16.264895 0 0 0 46.831211,85.464151 16.264895,16.264895 0 0 0 30.566314,69.199254 Z M 5.3164492,76.690579 A 3.9153737,3.9153737 0 0 0 1.401553,80.606053 3.9153737,3.9153737 0 0 0 5.3164492,84.521526 3.9153737,3.9153737 0 0 0 9.231922,80.606053 3.9153737,3.9153737 0 0 0 5.3164492,76.690579 Z')

  return svg;
}

(window as any)._debugWipeState = function () {
  localStorage.removeItem('user-info');
  localStorage.removeItem('squirrel-away-state');
  localStorage.removeItem('squirrel-away-online-state');
  onLoad();
}