'use strict';

const fs = require('fs')

const svgNS = 'http://www.w3.org/2000/svg';

window.saveState = () => {
  if (!fs.existsSync('backups')) {
    fs.mkdirSync('backups');
  }
  fs.renameSync('state.json', `backups/state_${Math.round(Date.now())}.json.backup`)
  fs.writeFileSync('state.json', JSON.stringify(window.state, null, 2))
};

window.addEventListener('load', () => {
  try {
    window.state = JSON.parse(fs.readFileSync('state.json'));
  } catch {
    window.state = {};
  }
  window.undoHistory = [];
  window.undoIndex = -1; // Points to the current state
  window.debugMode = true;
  if (window.debugMode) window.state.time = serializeDate(Date.now());

  pushUndoPoint();
  update();
  render();
});

document.addEventListener('keydown', documentKeyDown);
document.addEventListener('mousedown', documentMouseDown);

function render() {
  document.body.replaceChildren(renderPage(window.state))
}

function save() {
  if (window.debugMode) {
    console.log('Would save here');
  } else {
    window.saveState();
  }
}

function pushUndoPoint() {
  window.undoIndex++;

  // Any future history (for redo) becomes invalid at this point
  if (window.undoHistory.length > window.undoIndex)
    window.undoHistory = window.undoHistory.slice(0, window.undoIndex);

  // The undo history needs to contain a *copy* of all the information in the
  // current state. It's easiest to just serialize it and then we can
  // deserialize IFF we need to undo
  window.undoHistory[window.undoIndex] = JSON.stringify(window.state);
}

function undo() {
  // Can't undo past the beginning
  if (window.undoIndex <= 0) return;

  window.undoIndex--;

  // Restore to the previous state
  window.state = JSON.parse(window.undoHistory[window.undoIndex]);

  update();
  render();
  save();
}

function redo() {
  // Can't redo past the end
  if (window.undoIndex >= window.undoHistory.length - 1) return;

  window.undoIndex++;

  // Restore to the state
  window.state = JSON.parse(window.undoHistory[window.undoIndex]);

  update();
  render();
  save();
}

function renderPage(state) {
  const pageEl = document.createElement('div');
  pageEl.classList.add('page');

  if (window.debugMode)
    pageEl.classList.add('debug-mode');

  pageEl.appendChild(renderNavigator(state));
  pageEl.appendChild(renderList(state.lists[state.currentListIndex]));
  return pageEl;
}

function renderNavigator(state) {
  const navEl = document.createElement('div');
  navEl.classList.add('nav-panel');

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
    if (i === state.currentListIndex) itemEl.classList.add('active');
    itemEl.addEventListener('click', navListItemClick);

    const nameEl = itemEl.appendChild(document.createElement('h1'));
    nameEl.textContent = list.name;

    if (listHasReadyItems) {
      const readyIndicator = itemEl.appendChild(createReadyIndicatorSvg());
      readyIndicator.classList.add('ready-indicator');
    }

    const allocatedAmount = Math.round(getAllocatedRate(list.allocated) * 365.25 / 12);
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

  navEl.appendChild(renderTotals(state));

  return navEl;
}

function renderTotals(state) {
  const totalsSection = document.createElement('div');
  totalsSection.classList.add('totals-section');

  let totalBudget = 0;
  let totalSavedValue = 0;
  let totalSavedRate = 0;
  for (const list of state.lists) {
    totalBudget += getAllocatedRate(list.allocated) * 365.25 / 12;
    totalSavedValue += list.overflow.value;
    totalSavedRate += list.overflow.rate;
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

  const lastCommitTime = parseDate(state.time);
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
  listEl.list = list;
  listEl.classList.add('list');

  // Header
  const listHeaderEl = listEl.appendChild(document.createElement('div'));
  listHeaderEl.classList.add('list-header');

  // Header name section
  const listNameSection = listHeaderEl.appendChild(document.createElement('div'));
  listNameSection.classList.add('list-name');

  // Name heading
  const heading = listNameSection.appendChild(document.createElement('h1'));
  heading.classList.add('list-heading')
  makeEditable(heading, () => list.name, v => list.name = v)

  // Header info section
  const infoEl = listHeaderEl.appendChild(document.createElement('div'));
  infoEl.classList.add('list-info');

  // Allocated
  const allocatedEl = infoEl.appendChild(document.createElement('div'));
  allocatedEl.classList.add('list-allocated');

  // Allocated Amount
  const allocatedAmountEl = allocatedEl.appendChild(document.createElement('div'));
  allocatedAmountEl.classList.add('allocated-amount');
  makeEditable(allocatedAmountEl, () => list.allocated.dollars, v => list.allocated.dollars = parseCurrency(v));

  // Allocated Unit
  const allocationUnitEl = allocatedEl.appendChild(document.createElement('div'));
  allocationUnitEl.classList.add('allocated-unit');
  allocationUnitEl.textContent = list.allocated.unit;

  // Kitty
  if (list.overflow.value || list.overflow.rate) {
    const overflowEl = infoEl.appendChild(document.createElement('span'));
    overflowEl.classList.add('list-overflow');
    if (list.overflow.value >= 0) {
      overflowEl.appendChild(renderAmount(list.overflow));
      overflowEl.classList.remove('debt');
    } else {
      overflowEl.appendChild(renderAmount({
        value: -list.overflow.value,
        rate: -list.overflow.rate
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

function createListMenu() {
  return createMenu(menu => {
    menu.setIcon(createMenuButtonSvg());

    const deleteList = menu.newItem();
    deleteList.textContent = 'Delete list';
    deleteList.addEventListener('click', deleteListClick);

    const listInject = menu.newItem();
    listInject.textContent = 'Inject money';
    listInject.addEventListener('click', injectMoneyClick);
  })
}

function renderItem(item) {
  const itemEl = document.createElement('li');

  itemEl.item = item;
  itemEl.classList.add('item');
  // itemEl.classList.add('item-drag-over');
  if (item.purchased)
    itemEl.classList.add('purchased')
  if (item.price > 0 && item.saved.value >= item.price)
    itemEl.classList.add('afforded')
  if (item.saved.value > 0 && item.saved.value < item.price)
    itemEl.classList.add('partial-progress')
  if (item.saved.rate)
    itemEl.classList.add('active-progress');

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

  // Name
  const nameEl = itemInnerEl.appendChild(document.createElement('div'));
  nameEl.classList.add('item-name')
  makeEditable(nameEl, () => item.name, v => item.name = v);

  // Saved
  const savedEl = itemInnerEl.appendChild(document.createElement('div'));
  savedEl.classList.add('currency');
  savedEl.classList.add('saved');
  savedEl.appendChild(renderAmount(item.saved));

  // Price
  const priceEl = itemInnerEl.appendChild(document.createElement('div'));
  makeEditable(priceEl, () => formatCurrency(item.price), v => {
    const newPrice = parseCurrency(v);
    const list = itemEl.closest('.list').list;
    // Excess goes into the kitty
    if (newPrice < item.saved.value) {
      list.overflow.value += item.saved.value - newPrice;
      item.saved.value = newPrice;
    }
    item.price = newPrice;
  })
  priceEl.classList.add('currency');
  priceEl.classList.add('price');

  // ETA
  const etaEl = itemInnerEl.appendChild(document.createElement('div'));
  etaEl.classList.add('eta');
  const etaStr = item.expectedDate
    ? formatDate(parseDate(item.expectedDate))
    : 'Ready';
  etaEl.appendChild(document.createTextNode(etaStr));

  const buttonControlsEl = itemInnerEl.appendChild(document.createElement('div'));
  buttonControlsEl.classList.add('button-controls');

  // Delete
  const deleteEl = buttonControlsEl.appendChild(document.createElement('button'));
  deleteEl.classList.add('delete-item');
  deleteEl.classList.add('control-button');
  deleteEl.textContent = 'Delete';
  deleteEl.addEventListener('click', deleteItemClick)
  deleteEl.title = 'Remove item from list and redistribute the money back into the list';

  // Empty
  const emptyEl = buttonControlsEl.appendChild(document.createElement('button'));
  emptyEl.classList.add('empty-item');
  emptyEl.classList.add('control-button');
  emptyEl.textContent = 'Empty';
  emptyEl.addEventListener('click', emptyItemClick)
  emptyEl.title = 'Remove all the money from the item without redistributing it';

  // Redistribute
  const redistributeEl = buttonControlsEl.appendChild(document.createElement('button'));
  redistributeEl.classList.add('redistribute-item');
  redistributeEl.classList.add('control-button');
  redistributeEl.textContent = 'Redistribute';
  redistributeEl.addEventListener('click', redistributeItemClick)
  redistributeEl.title = 'Remove all the money and redistribute back into the list';

  // Purchase
  if (item.saved.value) {
    const purchaseEl = buttonControlsEl.appendChild(document.createElement('button'));
    purchaseEl.classList.add('purchase-item');
    purchaseEl.classList.add('control-button');
    purchaseEl.textContent = 'Purchased';
    purchaseEl.addEventListener('click', purchaseItemClick)
    purchaseEl.title = 'Remove item from list without redistributing the money';
  }

  return itemEl;
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

function finishedUserInteraction() {
  update();
  render();
  pushUndoPoint();
  save();
}

// Updates the state to the latest projected values and sets a timeout to repeat
// automatically the next time that the state needs to change
function update() {
  let state = window.state;

  const newTime = Date.now();

  state ??= {};
  state.time ??= serializeDate(newTime);
  state.nextNonlinearity ??= null;
  state.lists ??= [];
  state.currentListIndex ??= 0;

  // Need at least one list to render
  state.lists.length < 1 && state.lists.push({});

  state.currentListIndex = Math.max(state.currentListIndex, 0);
  state.currentListIndex = Math.min(state.currentListIndex, state.lists.length - 1);

  const lastCommitTime = parseDate(state.time);
  let timeOfNextNonlinearity = null;

  for (const list of state.lists) {
    list.name ??= 'Wish list';
    list.allocated ??= { dollars: 0, unit: '/month' };
    list.overflow ??= { value: 0, rate: 0 };
    list.items ??= [];
    list.purchaseHistory ??= [];

    const allocatedRate = getAllocatedRate(list.allocated);

    // We essentially iterate the time cursor forwards from the last commit time to the newTime
    let timeCursor = lastCommitTime;

    // The amount of money we have left over at `timeCursor`
    let remainingMoneyToAllocate = list.overflow.value + rateInDollarsPerMs(allocatedRate) * (newTime - lastCommitTime);

    // Rate of change of remainingMoneyToAllocate at `timeCursor`, which
    // eventually gets attributed to the overflow bucket
    let overflowRate = allocatedRate;

    // Are we in debt?
    let debt = 0;
    let debtRate = 0;
    if (remainingMoneyToAllocate < 0) {
      // The money isn't available to allocate to further items, so we move it
      // to the "debt" variable, which we'll put back in the overflow later
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

    // If there's still money left over, it goes into the overflow
    list.overflow.value = remainingMoneyToAllocate - debt;
    list.overflow.rate = overflowRate - debtRate;
  }

  state.time = serializeDate(newTime);
  state.nextNonlinearity = timeOfNextNonlinearity
    ? serializeDate(timeOfNextNonlinearity)
    : null;

  window.state = state;
  window.nextNonlinearity = timeOfNextNonlinearity;
  window.lastCommitTime = newTime;

  if (timeOfNextNonlinearity) {
    let timeoutPeriod = timeOfNextNonlinearity - Date.now();
    console.log(`Next nonlinearity in ${timeoutPeriod/1000}s`)

    window.nextNonLinearityTimer && clearTimeout(window.nextNonLinearityTimer);
    if (timeoutPeriod > 2147483647)
      timeoutPeriod = 2147483647
    if (timeoutPeriod < 1)
      timeoutPeriod = 1;
    window.nextNonLinearityTimer = setTimeout(() => {
      if (window.isEditing) {
        console.log('Not updating at nonlinearity because user is busy editing')
        return;
      }
      console.log('Updating at nonlinearity', formatDate(Date.now()))
      update(window.state);
      render();
    }, timeoutPeriod)
  }
}

function getAllocatedRate(allocated) {
  if (allocated.unit === '/month')
    return allocated.dollars * 12 / 365.25;
  else
  if (allocated.unit === '/day')
    return allocated.dollars;
  else
    throw new Error('Unknown unit')
}

function deleteItemClick(event) {
  update();

  const item = event.target.closest(".item").item;
  const list = event.target.closest(".list").list;
  const items = list.items;
  const index = items.indexOf(item);
  items.splice(index, 1);

  // Put the value back into the kitty
  list.overflow.value += item.saved.value;

  finishedUserInteraction();
}

function emptyItemClick(event) {
  update();

  const item = event.target.closest(".item").item;

  item.saved.value = 0;

  finishedUserInteraction();
}

function redistributeItemClick(event) {
  update();

  const item = event.target.closest(".item").item;
  const list = event.target.closest(".list").list;

  list.overflow.value += item.saved.value;
  item.saved.value = 0;

  finishedUserInteraction();
}

function purchaseItemClick(event) {
  update();

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
  actualPriceInput.value = formatCurrency(item.saved.value);

  actualPriceInput.addEventListener('keyup', e => e.code === 'Enter' && apply());

  actualPriceInput.addEventListener('keyup', () => {
    if (isNaN(parseFloat(actualPriceInput.value)))
      return actualPriceInput.classList.add('invalid')

    actualPriceInput.classList.remove('invalid');

    const actualPrice = parseCurrency(actualPriceInput.value);

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
    update();

    const actualPrice = parseCurrency(actualPriceInput.value);

    // Put all the money back into the kitty except which what was paid
    list.overflow.value += item.saved.value - actualPrice;

    list.purchaseHistory.push({
      name: item.name,
      priceEstimate: item.price,
      price: actualPrice,
      purchaseDate: serializeDate(Date.now())
    });

    list.items.splice(list.items.indexOf(item), 1);

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
  update();

  const list = event.target.closest(".list").list;
  list.items.push({ });

  finishedUserInteraction();
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

function parseDate(date) {
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

function makeEditable(el, get, set) {
  el.setAttribute('contentEditable', true);
  el.addEventListener('focus', focus)
  el.addEventListener('blur', blur)
  el.addEventListener('keypress', keypress)
  el.textContent = get();

  function focus() {
    beginEdit();
    el.textContent = get();
  }

  function blur() {
    if (el.textContent !== get()) {
      update();
      set(el.textContent);
      endEdit(true);
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
  window.state.currentListIndex = index;

  finishedUserInteraction();
}

function beginEdit(el) {
  update();

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

function endEdit(changed = true) {
  window.isEditing = false;
  window.elementBeingEdited = null;
  clearTimeout(window.editingTimeout);
  if (changed)
    finishedUserInteraction();
}

function newListClick() {
  update();

  window.state.lists.push({});
  window.state.currentListIndex = window.state.lists.length - 1;

  finishedUserInteraction();
}

function parseCurrency(value) {
  return Math.max(parseFloat(value) || 0, 0)
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

  update();

  const list = event.target.closest('.list').list;
  const targetItem = event.target.item ?? event.target.closest('.item').item;

  const sourceIndex = list.items.indexOf(sourceItem);
  const targetIndex = list.items.indexOf(targetItem);

  list.items.splice(sourceIndex, 1);
  list.items.splice(targetIndex, 0, sourceItem);

  finishedUserInteraction();
}

function getItemElAtNode(node) {
  if (node.item) return node;
  return node.closest('.item');
}

function createSmileySvg() {
  const r = 13;
  const margin = 2;
  const w = r * 2 + margin * 2;

  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('smiley');
  svg.setAttribute('viewBox', `${-r - margin} ${-r - margin} ${w} ${w}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', w);
  svg.style.display = 'block';

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
    window.showingMenu = menu;
    menuBody.style.display = 'block';
  }
}

function deleteListClick(event) {
  update();

  const list = event.target.closest('.list').list;
  const lists = window.state.lists;
  lists.splice(lists.indexOf(list), 1);
  window.state.currentListIndex--;

  finishedUserInteraction();
}

function injectMoneyClick(event) {
  hideMenu();

  update();

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
    update();

    const amount = parseCurrency(amountInput.value);

    list.overflow.value += amount;

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