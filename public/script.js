'use strict';

const svgNS = 'http://www.w3.org/2000/svg';

const userInfoStorage = localStorage && localStorage.getItem('user-info');
if (userInfoStorage) window.userInfo = JSON.parse(userInfoStorage);

let mode;
detectMode();

window.saveState = async () => {
  switch (mode) {
    case 'electron-local': {
      const fs = require('fs');
      if (!fs.existsSync('backups')) {
        fs.mkdirSync('backups');
      }
      fs.renameSync('state.json', `backups/state_${Math.round(Date.now())}.json.backup`)
      fs.writeFileSync('state.json', JSON.stringify(window.state, null, 2));
      console.log('Saved to file');
      break;
    }
    case 'web-local': {
      localStorage.setItem('squirrel-away-state', JSON.stringify(window.state));
      console.log('Saved to localStorage');
      break;
    }
    case 'online': {
      await synchronize();
      break;
    }
  }
};

window.loadState = async (renderOnChange) => {
  try {
    switch (mode) {
      case 'electron-local': {
        const fs = require('fs');
        window.state = upgradeStateFormat(JSON.parse(fs.readFileSync('state.json')));
        console.log('Loaded state from file');
        break;
      }
      case 'web-local': {
        const localStorageContent = localStorage.getItem('squirrel-away-state');
        if (!localStorageContent) {
          window.state = newState(uuidv4());
          return;
        }
        window.state = upgradeStateFormat(JSON.parse(localStorageContent));
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
    window.state = newState(uuidv4());
  }
}

window.addEventListener('load', async() => {
  window.syncStatus = 'sync-pending';
  window.undoHistory = []; // List of action IDs available to undo
  window.undoIndex = 0; // Points after the last entry in undoHistory
  window.debugMode = false;
  if (window.debugMode) window.state.time = serializeDate(Date.now());

  await window.loadState(false);

  // It's useful here to reconstruct the state from the actions list. For one
  // thing, if there are earlier bugs in the reducer that get fixed later,
  // running the re-reducer at startup means we recompute the correct end state.
  window.state = buildStateFromActions(window.state.id, window.state.actions);

  updateState();
  render();

  occasionallyRebuild();
});

window.addEventListener('focus', synchronize);

document.addEventListener('keydown', documentKeyDown);
document.addEventListener('mousedown', documentMouseDown);
window.addEventListener('blur', windowBlurEvent);

function render() {
  console.log('Rendering');

  window.currentListIndex ??= 0;
  window.currentListIndex = Math.max(window.currentListIndex, 0);
  window.currentListIndex = Math.min(window.currentListIndex, window.state.lists.length - 1);

  saveScrollPosition();
  document.body.replaceChildren(renderPage(window.state))
  restoreScrollPosition();
}

function save() {
  if (window.debugMode) {
    console.log('Would save here');
  } else {
    window.saveState();
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
   *      by re-running the reducer over the state using
   *      `buildStateFromActions`. If this becomes a performance bottleneck in
   *      future, it's easy to add checkpointing so not the whole history needs
   *      to be visited.
   *
   *   4. `buildStateFromActions` runs 2 passes. The first pass computes all the
   *      actions to skip because they were "undone". The second pass reduces
   *      over the non-undo actions using `foldAction`.
   *
   * Note that `foldAction` and `buildStateFromActions` are in some sense
   * mutually recursive, but `buildStateFromActions` suppresses the effects of
   * `Undo` actions in `foldAction` by running the initial pass. The naive
   * implementation may have had exponential asymptotic performance (exponential
   * to the number of undos in the history) since later undos need to
   * recalculate the whole history before them, including earlier undos which
   * calculate the whole history before *them*, etc. The double-pass instead
   * gets this done in linear time.
   */

  // Can't undo past the beginning
  if (window.undoIndex <= 0) return;

  const actionIdToUndo = window.undoHistory[--window.undoIndex];
  window.state = foldAction(window.state, { type: 'Undo', actionIdToUndo });

  updateState();
  save();
  render();
}

function redo() {
  // Can't redo past the end
  if (window.undoIndex >= window.undoHistory.length) return;

  // Restore to the state
  const actionIdToRedo = window.undoHistory[window.undoIndex++];
  window.state = foldAction(window.state, { type: 'Redo', actionIdToRedo });

  updateState();
  save();
  render();
}

function renderPage(state) {
  const pageEl = document.createElement('div');
  pageEl.id = 'page';

  if (window.debugMode)
    pageEl.classList.add('debug-mode');

  pageEl.classList.add(mode);
  pageEl.classList.add(window.syncStatus);

  pageEl.appendChild(renderNavigator(state));
  pageEl.appendChild(renderList(state.lists[window.currentListIndex]));

  // The gray overlay that goes underneath the mobile nav menu
  const mobileNavBackground = pageEl.appendChild(document.createElement('div'));
  mobileNavBackground.id = 'mobile-nav-background';
  mobileNavBackground.addEventListener('click', hideMobileNav);

  return pageEl;
}

function renderNavigator(state) {
  const navEl = document.createElement('div');
  navEl.classList.add('nav-panel');

  const userPanel = navEl.appendChild(document.createElement('div'))
  userPanel.classList.add('user-panel')
  const userStatusEl = userPanel.appendChild(document.createElement('div'))
  userStatusEl.classList.add('user-status');
  const userPanelButtonsEl = userPanel.appendChild(document.createElement('div'))
  userPanelButtonsEl.classList.add('user-panel-buttons');
  if (mode === 'online') {
    if (window.syncStatus !== 'sync-failure') {
      userStatusEl.innerHTML = `Hi, ${window.userInfo.name}`;
    } else {
      userStatusEl.innerHTML = `Connection error`;
    }

    const signOutButton = userPanelButtonsEl.appendChild(document.createElement('button'));
    signOutButton.className = 'sign-out';
    signOutButton.textContent = 'Sign out';
    signOutButton.addEventListener('click', signOutClick);
  } else if (mode === 'web-local') {
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
    itemEl.list = list;
    itemEl.classList.add('nav-item');
    if (listHasReadyItems) itemEl.classList.add('has-ready-items');
    if (i === window.currentListIndex) itemEl.classList.add('active');
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
  newListButtonContainer.classList = 'button-new-container';

  const newListButton = newListButtonContainer.appendChild(document.createElement('button'));
  newListButton.classList.add('button-new', 'svg-button');
  newListButton.addEventListener('click', newListClick);
  newListButton.appendChild(createPlusSvg());

  // Totals
  navEl.appendChild(renderTotals(state));

  // Report issues
  const reportIssuesEl = navEl.appendChild(document.createElement('div'));
  reportIssuesEl.className = 'report-issues';
  reportIssuesEl.innerHTML = '<a href="https://github.com/coder-mike/squirrel-away/issues" target="_blank">Feedback or problems</a>';

  return navEl;
}

function renderTotals(state) {
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

function renderCurrency(amount, decimals = 2) {
  const el = document.createElement('span');
  el.classList.add('currency')
  el.textContent = formatCurrency(amount, decimals);
  return el;
}

function renderList(list) {
  const listEl = document.createElement('div');
  listEl.id = 'current-list';
  listEl.list = list;
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
    read: () => list.name,
    write: value => addUserAction({ type: 'ListSetName', listId: list.id, newName: value })
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
    read: () => formatCurrency(list.budget.dollars),
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
      overflowEl.appendChild(renderAmount(list.kitty));
      overflowEl.classList.remove('debt');
    } else {
      overflowEl.appendChild(renderAmount({
        value: -list.kitty.value,
        rate: -list.kitty.rate
      }));
      overflowEl.classList.add('debt');
    }
  }

  // Menu
  listHeaderEl.appendChild(createListMenu())

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
  addItemEl.appendChild(createPlusSvg());

  return listEl;
}

function renderMobileTopMenuBar() {
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

function createListMenu() {
  return createMenu(menu => {
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

function renderItem(item) {
  const itemEl = document.createElement('li');

  itemEl.item = item;
  itemEl.classList.add('item');
  if (item.purchased)
    itemEl.classList.add('purchased')
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
    read: () => item.name,
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
  savedEl.appendChild(renderAmount(item.saved));

  // Item Info section
  const infoSectionEl = itemInnerEl.appendChild(document.createElement('div'));
  infoSectionEl.classList.add('info-section');

  // Item Price
  const priceEl = infoSectionEl.appendChild(document.createElement('span'));
  makeEditable(priceEl, {
    read: () => formatCurrency(item.price),
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

function createItemMenu(item) {
  return createMenu(menu => {
    menu.setIcon(createMenuButtonSvg());

    // Purchase
    const purchaseItem = menu.newItem();
    purchaseItem.textContent = 'Purchased';
    purchaseItem.addEventListener('click', purchaseItemClick);
    const smiley = purchaseItem.appendChild(createSmileySvg())
    smiley.style.display = 'inline';
    smiley.style.marginLeft = '7px';
    smiley.style.marginBottom = '-2px';
    smiley.style.opacity = 0.5;
    smiley.setAttribute('width', 16);
    smiley.setAttribute('height', 16);

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

function renderHistoryItem(item) {
  const historyItemEl = document.createElement('li');

  historyItemEl.item = item;
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

function renderAmount(amount) {
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
    //if (window.isEditing) return;
    // Check if element is removed
    if (executingFromTimer && !document.getElementById(amountSpan.id))
      return clearInterval(timer);
    const value = amount.value + rateInDollarsPerMs(amount.rate) * (Date.now() - lastCommitTime);
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

function createItemBackground(item, itemEl) {
  const amount = item.saved;
  // This function creates the moving background div to indicate progress, which
  // only applies
  if (amount.rate || (amount.value > 0 && amount.value < item.price)) {
    itemEl.id = generateNewId();
    let timer;
    const update = (synchronous) => {
      //if (window.isEditing) return;
      if (!synchronous && !document.getElementById(itemEl.id))
        return clearInterval(timer);
      const value = amount.value + rateInDollarsPerMs(amount.rate) * (Date.now() - lastCommitTime);
      const percent = (value / item.price) * 100;
      const color1 = amount.rate ? '#afd9ea' : '#dddddd';
      const color2 = amount.rate ? '#e1ecf1' : '#eaeaea';
      itemEl.style.background = `linear-gradient(90deg, ${color1} ${percent}%, ${color2} ${percent}%)`;
    }

    update(true);

    if (amount.rate) {
      // Once a second shouldn't be to taxing, and it's probably fast enough for
      // most real-world savings
      timer = setInterval(update, window.debugMode ? 100 : 1000)
    }
  }
}

function formatCurrency(value, decimals = 2) {
  return value.toFixed(decimals);
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
  if (window.state.lists.length < 1) {
    window.state = foldAction(window.state, { type: 'ListNew', id: uuidv4(), name: 'Wish list' });
  }

  const { timeOfNextNonlinearity } = project(window.state, toTime);

  window.state = state;
  window.nextNonlinearity = timeOfNextNonlinearity;
  window.lastCommitTime = toTime;

  if (timeOfNextNonlinearity) {
    let timeoutPeriod = timeOfNextNonlinearity - Date.now();
    console.log(`Next nonlinearity in ${timeoutPeriod/1000}s`)

    window.nextNonLinearityTimer && clearTimeout(window.nextNonLinearityTimer);
    if (timeoutPeriod > 2147483647)
      timeoutPeriod = 2147483647
    if (timeoutPeriod < 1)
      timeoutPeriod = 1;
    window.nextNonLinearityTimer = setTimeout(() => {
      if (window.isEditing || window.dialogBackgroundEl) {
        console.log('Not updating at nonlinearity because user is busy editing')
        return;
      }
      console.log('Updating at nonlinearity', formatDate(Date.now()))
      updateState(window.state);
      render();
    }, timeoutPeriod)
  }
}

// Projects the waterfall model to the future time `toTime`. Mutates `state` and
// returns { timeOfNextNonlinearity }
function project(state, toTime) {
  console.assert(state);
  console.assert(Array.isArray(state.lists));

  state.time ??= serializeDate(toTime);

  const lastCommitTime = deserializeDate(state.time);
  let timeOfNextNonlinearity = null;

  for (const list of state.lists) {
    list.name ??= 'Wish list';
    list.budget ??= list.allocated ?? { dollars: 0, unit: '/month' };
    list.kitty ??= list.overflow ?? { value: 0, rate: 0 };
    list.items ??= [];
    list.purchaseHistory ??= [];
    list.id ??= uuidv4();

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
      item.id ??= uuidv4();
      item.note ??= item.description; // Migrate from old name "description" to new name "note" // TODO: Remove this after a while
      item.description = item.note; // TODO: Remove this after a while

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

  return { timeOfNextNonlinearity };
}

function getAllocatedRate(budget) {
  if (budget.unit === '/month')
    return budget.dollars * 12 / 365.25;
  else
  if (budget.unit === '/day')
    return budget.dollars;
  else
    throw new Error('Unknown unit')
}

function deleteItemClick(event) {
  const item = event.target.closest(".item").item;

  addUserAction({ type: 'ItemDelete', itemId: item.id });

  finishedUserInteraction();
}

function redistributeItemClick(event) {

  const item = event.target.closest(".item").item;

  addUserAction({
    type: 'ItemRedistributeMoney',
    itemId: item.id
  });

  finishedUserInteraction();
}

function editItemNoteClick(event) {
  updateState();

  const item = event.target.closest(".item").item;

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

  const item = event.target.closest(".item").item;
  const list = event.target.closest(".list").list;

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

  window.dialogBackgroundEl = document.body.appendChild(document.createElement('div'));
  dialogBackgroundEl.classList.add('dialog-background');
  dialogBackgroundEl.addEventListener('mousedown', hideDialog);

  const dialogEl = window.dialogBackgroundEl.appendChild(document.createElement('div'));
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
  window.dialogBackgroundEl && window.dialogBackgroundEl.remove();
  window.dialogBackgroundEl = undefined;
}

function addItemClick(event) {
  const list = event.target.closest(".list").list;
  addUserAction({ type: 'ItemNew', listId: list.id });

  finishedUserInteraction();

  const itemNames = document.getElementsByClassName('item-name');
  const addedItemName = itemNames[itemNames.length - 1];
  selectAllInContentEditable(addedItemName);
}

// For debuggability, the rates are stored in dollars per day, but we need them
// in dollars per millisecond for most calculations
function rateInDollarsPerMs(rate) {
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

function deserializeDate(date) {
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

function makeEditable(el, { read, write, requiresRender }) {
  requiresRender ??= true;
  console.assert(read);
  console.assert(write);

  el.setAttribute('contentEditable', true);
  el.addEventListener('focus', focus)
  el.addEventListener('blur', blur)
  el.addEventListener('keypress', keypress)
  el.textContent = read();

  function focus() {
    beginEdit();
    el.textContent = read();
    setTimeout(() => {
      selectAllInContentEditable(el);
    }, 1)
  }

  function blur() {
    if (el.textContent !== read()) {
      updateState();
      write(el.textContent);
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

function navListItemClick(event) {
  const list = event.target.list ?? event.target.closest(".nav-item").list;

  const index = window.state.lists.indexOf(list);
  window.currentListIndex = index;

  render();
}

function beginEdit(el) {
  updateState();

  window.isEditing = true;
  window.elementBeingEdited = el;
  // The nonnlinearities don't update until we finish editing, so in case the
  // user leaves the edit in progress, we cancel after 1 minute of inactivity
  window.editingTimeout = setTimeout(editTimeout, 60000);
}

function continueEdit() {
  clearTimeout(window.editingTimeout);
  window.editingTimeout = setTimeout(editTimeout, 60000);
}

function editTimeout() {
  window.elementBeingEdited && window.elementBeingEdited.blur();
}

function endEdit(changed = true, requiresRender = true) {
  window.isEditing = false;
  window.elementBeingEdited = null;
  clearTimeout(window.editingTimeout);
  if (changed)
    finishedUserInteraction(requiresRender);
}

function newListClick() {
  let name = 'Wish list';
  let counter = 1;
  while (window.state.lists.some(l => l.name === name))
    name = `Wish list ${++counter}`;

  addUserAction({ type: 'ListNew', name });

  window.currentListIndex = window.state.lists.length - 1;

  finishedUserInteraction();

  const listHeading = document.getElementById('list-heading');
  selectAllInContentEditable(listHeading);
}

function parseNonNegativeCurrency(value) {
  return Math.max(parseFloat(value) || 0, 0)
}

function parseCurrency(value) {
  return parseFloat(value) || 0;
}

function createPlusSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const r = 15;
  const margin = 2;
  const w = r * 2 + margin * 2;

  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('plus-svg');
  svg.setAttribute('viewBox', `${-r - margin} ${-r - margin} ${w} ${w}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', w);
  svg.style.display = 'block';

  const circle = svg.appendChild(document.createElementNS(ns, 'circle'));
  circle.setAttribute('r', r);

  const plus = svg.appendChild(document.createElementNS(ns, 'path'));
  const s = r/2;
  plus.setAttribute('d', `M ${-s} 0 L ${s} 0 M 0 ${-s} L 0 ${s}`);

  return svg;
}

function itemDrag(event) {
  const item = event.target.item ?? event.target.closest('.item').item;
  window.draggingItem = item;
  event.dataTransfer.dropEffect = 'move';
}

function itemDragStart(event) {
  getItemElAtNode(event.target).classList.add('item-dragging');
}

function itemDragEnd(event) {
  getItemElAtNode(event.target).classList.remove('item-dragging');
}

function itemDragEnter(event) {
  if (!window.draggingItem) return;
  const itemEl = getItemElAtNode(event.target);
  if (itemEl.item === window.draggingItem) return;
  itemEl.dragOverCount = (itemEl.dragOverCount ?? 0) + 1;
  if (itemEl.dragOverCount)
    itemEl.classList.add('item-drag-over');
}

function itemDragLeave(event) {
  if (!window.draggingItem) return;
  const itemEl = getItemElAtNode(event.target);
  if (itemEl.item === window.draggingItem) return;
  itemEl.dragOverCount = (itemEl.dragOverCount ?? 0) - 1;
  if (!itemEl.dragOverCount)
    itemEl.classList.remove('item-drag-over');
}

function itemDragOver(event) {
  if (!window.draggingItem) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

function itemDrop(event) {
  event.preventDefault();

  const sourceItem = window.draggingItem;
  if (!sourceItem) return;
  window.draggingItem = undefined;

  event.dataTransfer.dropEffect = 'move';

  const list = event.target.closest('.list').list;
  const targetItem = event.target.item ?? event.target.closest('.item').item;

  addUserAction({
    type: 'ItemMove',
    itemId: sourceItem.id,
    targetListId: list.id,
    targetIndex: list.items.indexOf(targetItem),
  });

  finishedUserInteraction();
}

function getItemElAtNode(node) {
  if (node.item) return node;
  return node.closest('.item');
}

function createSmileySvg() {
  const r = 13;
  const margin = 1;
  const w = r * 2 + margin * 2;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('smiley');
  svg.setAttribute('viewBox', `${-r - margin} ${-r - margin} ${w} ${w}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', w);
  // svg.style.display = 'block';

  const circle = svg.appendChild(document.createElementNS(svgNS, 'circle'));
  circle.classList.add('head');
  circle.setAttribute('r', r);

  const leftEye = svg.appendChild(document.createElementNS(svgNS, 'circle'));
  leftEye.classList.add('eye');
  leftEye.setAttribute('r', 2);
  leftEye.setAttribute('cx', -4.5);
  leftEye.setAttribute('cy', -5);

  const rightEye = svg.appendChild(document.createElementNS(svgNS, 'circle'));
  rightEye.classList.add('eye');
  rightEye.setAttribute('r', 2);
  rightEye.setAttribute('cx', 4.5);
  rightEye.setAttribute('cy', -5);

  const mouth = svg.appendChild(document.createElementNS(svgNS, 'path'));
  mouth.classList.add('mouth');
  const s = 8;
  mouth.setAttribute('d', `M ${-s},0 Q ${-s},${s} 0,${s} Q ${s},${s} ${s},0 Z`);
  // mouth.setAttribute('transform', 'translate(0 1)')

  return svg;
}

function createReadyIndicatorSvg() {
  const r = 4;
  const margin = 1;
  const w = r * 2 + margin * 2;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('smiley');
  svg.setAttribute('viewBox', `${-r - margin} ${-r - margin} ${w} ${w}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', w);
  svg.style.display = 'block';

  const circle = svg.appendChild(document.createElementNS(svgNS, 'circle'));
  circle.setAttribute('r', r);

  return svg;
}

function generateNewId() {
  window.idCounter = (window.idCounter ?? 0) + 1;
  return `id${window.idCounter}`;
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
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.style.display = 'block';

  for (let i = -1; i <= 1; i++) {
    const circle = svg.appendChild(document.createElementNS(svgNS, 'circle'));
    circle.setAttribute('cy', i * pitch);
    circle.setAttribute('r', r);
  }

  return svg;
}

function createMenu(content) {
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
    newItem() {
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
    window.showingMenu = undefined;
    menuBody.style.display = 'none';
  } else {
    hideMenu();
    window.showingMenu = menu;
    menuBody.style.display = 'block';
  }
}

function deleteListClick(event) {
  const list = event.target.closest('.list').list;

  addUserAction({ type: 'ListDelete', listId: list.id })
  window.currentListIndex--;

  finishedUserInteraction();
}

function injectMoneyClick(event) {
  hideMenu();

  updateState();

  const list = event.target.closest('.list').list;

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
  if (window.showingMenu) {
    const menuBody = window.showingMenu.getElementsByClassName('menu-body')[0];
    menuBody.style.display = 'none';
    window.showingMenu = undefined;
  }
}

// https://stackoverflow.com/a/8943487
function convertUrlsToLinks(text) {
  const urlRegex =/(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
  return text.replace(urlRegex, function(url) {
    return '<a href="' + url + '" target="_blank">' + url + '</a>';
  });
}

function apiRequest(cmd, data) {
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

function signInClick() {
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
  errorNotice.classList = 'login-error';

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
      mode = 'online';
      window.state = parseState(localStorage.getItem('squirrel-away-online-state'));
      window.state = mergeStates(window.state, result.state);
      window.userInfo = result.userInfo;
      localStorage.setItem('user-info', JSON.stringify(window.userInfo));

      finishedUserInteraction();
    } else {
      errorNotice.textContent = 'Failed to log in: ' + (result.reason ?? '')
    }
  }
}

function signUpClick() {
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
  errorNotice.classList = 'login-error';

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
    const state = window.state;

    const result = await apiRequest('new-account', { name, email, password, state });
    if (result.success) {
      mode = 'online';
      window.state = result.state;
      window.userInfo = result.userInfo;
      localStorage.setItem('squirrel-away-online-state', JSON.stringify(window.state));
      localStorage.setItem('user-info', JSON.stringify(window.userInfo));
      // The next time the user logs out, they won't see the state, so it's hopefully less confusing
      localStorage.removeItem('state');

      finishedUserInteraction();
    } else {
      errorNotice.textContent = 'Failed to sign up: ' + (result.reason ?? '')
    }
  }
}

function detectMode() {
  if (window.userInfo?.id) {
    mode = 'online';
  } else if (typeof require !== 'undefined') {
    mode = 'electron-local';
  } else {
    mode = 'web-local';
  }
}

async function signOutClick() {
  delete window.userInfo;
  localStorage && localStorage.removeItem('user-info');
  localStorage && localStorage.removeItem('squirrel-away-online-state');
  window.syncStatus = 'sync-pending';
  detectMode();
  await loadState();
  finishedUserInteraction();
}

function saveScrollPosition() {
  const list = document.getElementById('current-list');
  if (list) window.listScrollPosition = list.scrollTop;
}

function restoreScrollPosition() {
  // This is a hack to keep the user scrolled to the right location when the
  // page refreshes. Otherwise, whenever you add a new item, the scroll position
  // is lost and you go back up to the top.
  const list = document.getElementById('current-list');
  list.scrollTop = window.listScrollPosition;
}

function selectAllInContentEditable(el) {
  el.focus();
  //document.execCommand('selectAll', false, null);
}

// https://stackoverflow.com/a/2117523
function uuidv4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

// Folds the action into the state and records it in the undo history
function addUserAction(action) {
  window.state = foldAction(window.state, action);

  window.undoHistory[window.undoIndex++] = action.id;
  // Any future history (for redo) becomes invalid at this point
  if (window.undoHistory.length > window.undoIndex)
    window.undoHistory = window.undoHistory.slice(0, window.undoIndex);
}

// Mutates `state` to include the effect of the given action, unless
// `skipEffect` is true, in which case the hash will be updated but no effect on
// the state lists.
function foldAction(state, action, skipEffect) {
  action.id ??= uuidv4();
  action.time ??= serializeDate(Date.now());
  const time = deserializeDate(action.time);

  project(state, time);

  // Like a git hash, if "actions" are like commits. The hash allows us to
  // quickly merge two histories or determine if there's a conflict (a fork in
  // the history). Note that "JSON.stringify" here is technically not correct
  // since it's not guaranteed to produce a canonical/deterministic output each
  // time across different environments, but in this case it's safe for it to
  // produce a different hash for the same history since it will just fall back
  // to a full history merge (the hash is just used as an optimization).
  //
  // Note that the state hash isn't actually a hash of the full state, but a
  // hash that includes the whole action history, which fully determines the
  // state, excluding differences in the projected time.
  const { hash, ...contentToHash } = action;
  state.hash = action.hash = md5Hash(JSON.stringify([state.hash, contentToHash]));

  state.actions.push(action);

    if (skipEffect) {
    return state;
  }

  const findList = id => state.lists.find(l => l.id === id);
  const findItem = id => {
    for (const list of state.lists)
      for (const item of list.items)
        if (item.id === id) return { list, item };
  }

  switch (action.type) {
    case 'New': {
      state.id = action.id;
      state.time = action.time;
      state.lists = [];
      break;
    }
    case 'MigrateState': {
      // Migrate from a pre-event-sourced state structure
      Object.assign(state, deepClone(action.state));
      state.time = action.time;
      break;
    }
    case 'ListNew': {
      state.lists.push({ id: action.id, name: action.name });
      break;
    }
    case 'ListDelete': {
      const index = state.lists.findIndex(list => list.id === action.listId);
      if (index != -1) state.lists.splice(index, 1);
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
      findList(action.listId)?.items?.push({ id: action.id });
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
      if (item) item.description = action.note; // TODO: Remove this after a while
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
      return buildStateFromActions(state.id, state.actions);
    }
    case 'Redo': {
      // As with 'Undo'
      return buildStateFromActions(state.id, state.actions);
    }
  }

  // Run another projection just to update any side effects of the action. For
  // example, redistributing newly-available cash
  project(state, time);

  return state;
}

// https://stackoverflow.com/a/33486055
function md5Hash(d){var r = M(V(Y(X(d),8*d.length)));return r.toLowerCase()};function M(d){for(var _,m="0123456789ABCDEF",f="",r=0;r<d.length;r++)_=d.charCodeAt(r),f+=m.charAt(_>>>4&15)+m.charAt(15&_);return f}function X(d){for(var _=Array(d.length>>2),m=0;m<_.length;m++)_[m]=0;for(m=0;m<8*d.length;m+=8)_[m>>5]|=(255&d.charCodeAt(m/8))<<m%32;return _}function V(d){for(var _="",m=0;m<32*d.length;m+=8)_+=String.fromCharCode(d[m>>5]>>>m%32&255);return _}function Y(d,_){d[_>>5]|=128<<_%32,d[14+(_+64>>>9<<4)]=_;for(var m=1732584193,f=-271733879,r=-1732584194,i=271733878,n=0;n<d.length;n+=16){var h=m,t=f,g=r,e=i;f=md5_ii(f=md5_ii(f=md5_ii(f=md5_ii(f=md5_hh(f=md5_hh(f=md5_hh(f=md5_hh(f=md5_gg(f=md5_gg(f=md5_gg(f=md5_gg(f=md5_ff(f=md5_ff(f=md5_ff(f=md5_ff(f,r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+0],7,-680876936),f,r,d[n+1],12,-389564586),m,f,d[n+2],17,606105819),i,m,d[n+3],22,-1044525330),r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+4],7,-176418897),f,r,d[n+5],12,1200080426),m,f,d[n+6],17,-1473231341),i,m,d[n+7],22,-45705983),r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+8],7,1770035416),f,r,d[n+9],12,-1958414417),m,f,d[n+10],17,-42063),i,m,d[n+11],22,-1990404162),r=md5_ff(r,i=md5_ff(i,m=md5_ff(m,f,r,i,d[n+12],7,1804603682),f,r,d[n+13],12,-40341101),m,f,d[n+14],17,-1502002290),i,m,d[n+15],22,1236535329),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+1],5,-165796510),f,r,d[n+6],9,-1069501632),m,f,d[n+11],14,643717713),i,m,d[n+0],20,-373897302),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+5],5,-701558691),f,r,d[n+10],9,38016083),m,f,d[n+15],14,-660478335),i,m,d[n+4],20,-405537848),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+9],5,568446438),f,r,d[n+14],9,-1019803690),m,f,d[n+3],14,-187363961),i,m,d[n+8],20,1163531501),r=md5_gg(r,i=md5_gg(i,m=md5_gg(m,f,r,i,d[n+13],5,-1444681467),f,r,d[n+2],9,-51403784),m,f,d[n+7],14,1735328473),i,m,d[n+12],20,-1926607734),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+5],4,-378558),f,r,d[n+8],11,-2022574463),m,f,d[n+11],16,1839030562),i,m,d[n+14],23,-35309556),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+1],4,-1530992060),f,r,d[n+4],11,1272893353),m,f,d[n+7],16,-155497632),i,m,d[n+10],23,-1094730640),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+13],4,681279174),f,r,d[n+0],11,-358537222),m,f,d[n+3],16,-722521979),i,m,d[n+6],23,76029189),r=md5_hh(r,i=md5_hh(i,m=md5_hh(m,f,r,i,d[n+9],4,-640364487),f,r,d[n+12],11,-421815835),m,f,d[n+15],16,530742520),i,m,d[n+2],23,-995338651),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+0],6,-198630844),f,r,d[n+7],10,1126891415),m,f,d[n+14],15,-1416354905),i,m,d[n+5],21,-57434055),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+12],6,1700485571),f,r,d[n+3],10,-1894986606),m,f,d[n+10],15,-1051523),i,m,d[n+1],21,-2054922799),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+8],6,1873313359),f,r,d[n+15],10,-30611744),m,f,d[n+6],15,-1560198380),i,m,d[n+13],21,1309151649),r=md5_ii(r,i=md5_ii(i,m=md5_ii(m,f,r,i,d[n+4],6,-145523070),f,r,d[n+11],10,-1120210379),m,f,d[n+2],15,718787259),i,m,d[n+9],21,-343485551),m=safe_add(m,h),f=safe_add(f,t),r=safe_add(r,g),i=safe_add(i,e)}return Array(m,f,r,i)}function md5_cmn(d,_,m,f,r,i){return safe_add(bit_rol(safe_add(safe_add(_,d),safe_add(f,i)),r),m)}function md5_ff(d,_,m,f,r,i,n){return md5_cmn(_&m|~_&f,d,_,r,i,n)}function md5_gg(d,_,m,f,r,i,n){return md5_cmn(_&f|m&~f,d,_,r,i,n)}function md5_hh(d,_,m,f,r,i,n){return md5_cmn(_^m^f,d,_,r,i,n)}function md5_ii(d,_,m,f,r,i,n){return md5_cmn(m^(_|~f),d,_,r,i,n)}function safe_add(d,_){var m=(65535&d)+(65535&_);return(d>>16)+(_>>16)+(m>>16)<<16|65535&m}function bit_rol(d,_){return d<<_|d>>>32-_}

// Build a new State from the given list of actions
function buildStateFromActions(id, actions) {
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
    (state, action) => foldAction(state, action, skip.has(action.id)),
    { ...emptyState(), id });
}

function emptyState() {
  return {
    actions: [],
    lists: [],
    hash: md5Hash('')
  }
}

function newState(id) {
  return foldAction(emptyState(), { type: 'New', id });
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function occasionallyRebuild() {
  setInterval(() => {
    // This is to prove to ourselves that the "actions" property of the state
    // contains all the necessary information to rebuild the latest state of all
    // the lists. I want this here because it'll cause bugs to surface earlier
    // rather than later if there's a problem building state from the actions.
    if (!window.dialogBackgroundEl && !window.isEditing && window.state.actions) {
      console.log('Rebuilding the list state from the actions')
      window.state = buildStateFromActions(window.state.id, window.state.actions);
      window.lastCommitTime = deserializeDate(newState.time);

      render();
    }
  }, 60_000);
}

function mergeStates(...states) {
  if (states.length < 2) return states[0];

  const [state1, state2, ...rest] = states;
  if (rest.length > 0) return mergeStates(mergeStates(state1, state2), ...rest);

  if (!state2) return state1;
  if (!state1) return state2;

  // We merge based on the actions, so if either don't have actions then we don't have anything to merge on
  upgradeStateFormat(state1);
  upgradeStateFormat(state2);

  // Special case: if the hash is the same, the content is the same
  if (state1.hash === state2.hash) return state1;

  // Special case: if one state can do a fast-forward to reach the other state
  if (state1.actions.some(a => a.hash === state2.hash)) return state1;
  if (state2.actions.some(a => a.hash === state1.hash)) return state2;

  const itLeft = state1.actions[Symbol.iterator]();
  const itRight = state2.actions[Symbol.iterator]();

  let left = itLeft.next();
  let right = itRight.next();
  let newState = emptyState();

  while (!left.done || !right.done) {
    let pickAction;
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
    newState = foldAction(newState, pickAction);
  }

  return newState;
}

// TODO: Remove this at some point
function upgradeStateFormat(state) {
  if (!state) return state;
  // For backwards compatibility with states that weren't created using an
  // actions list, we need to set up an actions list that is equivalent to the
  // existing state.
  if (!state.actions) {
    const id = state.id;
    const time = state.time;
    const snapshot = {
      id: state.id,
      lists: state.lists.map(list => ({
        id: list.id,
        name: list.name,
        budget: {
          dollars: list.allocated.dollars,
          unit: list.allocated.unit
        },
        kitty: {
          value: list.overflow.value,
          rate: list.overflow.rate
        },
        purchaseHistory: list.purchaseHistory.map(p => ({
          id: p.id,
          name: p.name,
          priceEstimate: p.priceEstimate,
          price: p.price,
          purchaseDate: p.purchaseDate
        })),
        items: list.items.map(i => ({
          id: i.name,
          price: i.price,
          saved: { value: i.saved.value, rate: i.saved.rate },
          note: i.note ?? i.description
        }))
      }))
    };
    return foldAction(emptyState(), {
      type: 'MigrateState',
      id,
      time,
      state: snapshot
    });
  }
  return state;
}

async function synchronize(renderOnChange = true) {
  if (mode !== 'online') return;

  console.log('Synchronizing with localStorage');
  let state = window.state;

  // Synchronize with local storage first

  const local = parseState(localStorage.getItem('squirrel-away-online-state'));
  state = mergeStates(state, local);

  if (!sameState(state, local)) {
    console.log('Pushing state to local storage');
    localStorage.setItem('squirrel-away-online-state', JSON.stringify(state));
  }

  if (!sameState(state, window.state)) {
    console.log('Loading changes from local storage');
    window.state = state;
    window.lastCommitTime = deserializeDate(state.time);
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
    const state = mergeStates(window.state, remote);
    if (!sameState(state, remote)) {
      console.log('Pushing state to server');
      await saveRemoteState(state);
    }

    if (!sameState(state, window.state)) {
      console.log('Rendering changes from server');
      window.state = state;
      window.lastCommitTime = deserializeDate(state.time);
      window.syncStatus = 'sync-success';
      render();
    } else {
      console.log('No changes from server');

      if (window.syncStatus !== 'sync-success') {
        window.syncStatus = 'sync-success';
        render();
      }
    }
  } catch (e) {
    window.syncStatus = 'sync-failure';
    console.error(e);
    render();
  }
}

async function loadRemoteState() {
  const response = await apiRequest('load', { userId: window.userInfo.id });
  return response.success ? response.state : undefined;
}

async function saveRemoteState(state) {
  await apiRequest('save', { userId: window.userInfo.id, state });
}

function parseState(json) {
  return json && upgradeStateFormat(JSON.parse(json));
}

function sameState(state1, state2) {
  return state1?.hash === state2?.hash;
}

function hideMobileNav() {
  document.getElementById('page').classList.remove('mobile-nav-showing');
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
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.style.display = 'block';

  for (let i = -1; i <= 1; i++) {
    const line = svg.appendChild(document.createElementNS(svgNS, 'line'));
    line.setAttribute('x1', -w/2 + margin);
    line.setAttribute('x2', +w/2 - margin);
    line.setAttribute('y1', i * pitch);
    line.setAttribute('y2', i * pitch);
    line.setAttribute('stroke-width', thickness);
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
  svg.setAttribute('width', 50);
  svg.setAttribute('height', 50);
  svg.style.display = 'block';

  const path = svg.appendChild(document.createElementNS(svgNS, 'path'));
  path.setAttribute('d', 'm 57.743013,29.127309 c -12.93795,0.179207 -22.347307,11.920556 -21.895807,24.86346 0.453995,13.014395 12.723204,19.422555 11.922584,33.151853 -0.252254,4.325777 -2.256285,9.132424 -8.96533,14.164208 17.743524,-2.957243 17.743524,-20.700777 17.743524,-35.487045 0,-18.265493 16.265304,-18.27202 22.707897,-8.660942 C 82.21312,36.458046 68.526468,28.977945 57.743013,29.127309 Z M 15.583664,51.653267 c -0.04923,-0.0018 -0.09976,0.0016 -0.151328,0.0098 -1.436303,0.228226 -1.15389,2.04243 -1.331342,4.755288 a 9.8298778,9.8298778 0 0 0 -2.870038,-0.428571 9.8298778,9.8298778 0 0 0 -9.829403,9.829983 9.8298778,9.8298778 0 0 0 9.829403,9.82998 9.8298778,9.8298778 0 0 0 9.829981,-9.82998 9.8298778,9.8298778 0 0 0 -2.327682,-6.351744 c -1.192858,-3.122049 -1.645077,-7.758565 -3.149591,-7.81477 z M 9.2169048,62.582976 a 1.9162314,1.9162314 0 0 1 1.9164392,1.916439 1.9162314,1.9162314 0 0 1 -1.9164392,1.916439 1.9162314,1.9162314 0 0 1 -1.9164393,-1.916439 1.9162314,1.9162314 0 0 1 1.9164393,-1.916439 z m 21.3494092,6.616278 a 16.264895,16.264895 0 0 0 -16.264896,16.264897 16.264895,16.264895 0 0 0 9.497867,14.789739 1.4114845,1.4114845 0 0 0 -0.01155,0.18136 1.4114845,1.4114845 0 0 0 1.41105,1.41162 1.4114845,1.4114845 0 0 0 1.196185,-0.66191 16.264895,16.264895 0 0 0 4.171345,0.54409 A 16.264895,16.264895 0 0 0 46.831211,85.464151 16.264895,16.264895 0 0 0 30.566314,69.199254 Z M 5.3164492,76.690579 A 3.9153737,3.9153737 0 0 0 1.401553,80.606053 3.9153737,3.9153737 0 0 0 5.3164492,84.521526 3.9153737,3.9153737 0 0 0 9.231922,80.606053 3.9153737,3.9153737 0 0 0 5.3164492,76.690579 Z')

  return svg;
}