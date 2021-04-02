const fs = require('fs')

window.saveState = () => {
  fs.renameSync('state.json', `backups/state_${Math.round(Date.now())}.json.backup`)
  fs.writeFileSync('state.json', JSON.stringify(window.state, null, 2))
};

window.addEventListener('load', () => {
  window.state = JSON.parse(fs.readFileSync('state.json'));
  window.undoHistory = [];
  window.undoIndex = -1; // Points to the current state
  // For the sake of debugging, we revert the state to the last committed state
  window.statelessMode = true;
  if (window.statelessMode) window.state.time = serializeDate(Date.now());

  pushUndoPoint();
  update();
  render();
});

document.addEventListener('keydown', documentKeyUp);

function render() {
  document.body.replaceChildren(renderPage(window.state))
}

function save() {
  if (window.statelessMode) {
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

  if (window.statelessMode)
    pageEl.classList.add('stateless-mode');

  pageEl.appendChild(renderNavigator(state));
  pageEl.appendChild(renderList(state.lists[state.currentListIndex]));
  return pageEl;
}

function renderNavigator(state) {
  const navEl = document.createElement('div');
  navEl.classList.add('nav-panel');

  const listListEl = navEl.appendChild(document.createElement('ul'));
  listListEl.classList.add('list-nav');

  for (const [i, list] of state.lists.entries()) {
    const listHasReadyItems = list.items.some(item => item.saved.value >= item.price);

    const itemEl = listListEl.appendChild(document.createElement('li'));
    itemEl.list = list;
    itemEl.classList.add('nav-item');
    itemEl.classList.add(listHasReadyItems ? 'has-ready-items' : 'no-ready-items');
    itemEl.classList.add(i === state.currentListIndex ? 'active' : 'not-active');
    itemEl.addEventListener('click', navListItemClick);

    const nameEl = itemEl.appendChild(document.createElement('h1'));
    nameEl.textContent = list.name;

    const allocatedEl = itemEl.appendChild(document.createElement('div'));
    const allocatedAmount = Math.round(getAllocatedRate(list.allocated) * 365.25 / 12);
    allocatedEl.textContent = `$${allocatedAmount} / month`;
  }

  const newListButton = navEl.appendChild(document.createElement('button'));
  newListButton.classList.add('button-new', 'svg-button');
  newListButton.addEventListener('click', newListClick);
  newListButton.appendChild(createPlusSvg());

  return navEl;
}

function renderList(list) {
  const listEl = document.createElement('div');
  listEl.list = list;
  listEl.classList.add('list');

  // Header
  const listHeaderEl = listEl.appendChild(document.createElement('div'));
  listHeaderEl.classList.add('list-header');

  // Name heading
  const heading = listHeaderEl.appendChild(document.createElement('h1'));
  heading.classList.add('list-heading')
  makeEditable(heading, () => list.name, v => list.name = v)

  // Overflow
  if (list.overflow.value || list.overflow.rate) {
    const overflowEl = listHeaderEl.appendChild(document.createElement('div'));
    overflowEl.classList.add('list-overflow');
    overflowEl.appendChild(renderAmount(list.overflow));
  }

  // Allocated
  const allocatedEl = listHeaderEl.appendChild(document.createElement('div'));
  allocatedEl.classList.add('list-allocated');

  // Allocated Amount
  const allocatedAmountEl = allocatedEl.appendChild(document.createElement('div'));
  allocatedAmountEl.classList.add('allocated-amount');
  makeEditable(allocatedAmountEl, () => list.allocated.dollars, v => list.allocated.dollars = parseCurrency(v));

  // Allocated Unit
  const allocationUnitEl = allocatedEl.appendChild(document.createElement('div'));
  allocationUnitEl.classList.add('allocated-unit');
  allocationUnitEl.textContent = list.allocated.unit;

  const itemsEl = listEl.appendChild(document.createElement('ol'));
  for (const item of list.items) {
    itemsEl.appendChild(renderItem(item));
  }

  const addItemEl = listEl.appendChild(document.createElement('button'));
  addItemEl.classList.add('add-item', 'svg-button');
  addItemEl.addEventListener('click', addItemClick);
  addItemEl.appendChild(createPlusSvg());

  return listEl;
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
  makeEditable(priceEl, () => formatCurrency(item.price), v => item.price = parseCurrency(v))
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

function renderAmount(amount) {
  if (!amount.rate)
    return document.createTextNode(formatCurrency(amount.value));

  const amountSpan = document.createElement('span');
  amountSpan.id = 'x' + Math.round(Math.random() * 10000000);
  amountSpan.classList.add('money');

  const mainAmount = amountSpan.appendChild(document.createElement('span'));
  mainAmount.classList.add('main-amount');
  const subCents = amountSpan.appendChild(document.createElement('span'));
  subCents.classList.add('sub-cents');
  let executingFromTimer = false;
  const update = () => {
    if (window.isEditing) return;
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
    const update = () => {
      const value = amount.value + rateInDollarsPerMs(amount.rate) * (Date.now() - lastCommitTime);
      const percent = (value / item.price) * 100;
      const color = amount.rate ? '#c6dfe9' : '#e9e9e9'
      itemEl.style.background = `linear-gradient(90deg, ${color} ${percent}%, white ${percent}%)`;
    }

    update();

    if (amount.rate) {
      // Once a second shouldn't be to taxing, and it's probably fast enough for
      // most real-world savings
      const timer = setInterval(update, 1000)
      itemEl.addEventListener('DOMNodeRemoved', () => {
        clearInterval(timer);
      })
    }
  }
}

function formatCurrency(value) {
  return value.toFixed(2);
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

  const lastCommitTime = parseDate(state.time);
  let timeOfNextNonlinearity = null;

  for (const list of state.lists) {
    list.name ??= 'Wish list';
    list.allocated ??= { dollars: 0, unit: '/month' };
    list.overflow ??= { value: 0, rate: 0 };
    list.items ??= [];

    const allocatedRate = getAllocatedRate(list.allocated);

    // We essentially iterate the time cursor forwards from the last commit time to the newTime
    let timeCursor = lastCommitTime;

    // The amount of money we have left over at `timeCursor`
    let remainingMoneyToAllocate = list.overflow.value + rateInDollarsPerMs(allocatedRate) * (newTime - lastCommitTime);

    // Rate of change of remainingMoneyToAllocate at `timeCursor`, which
    // eventually gets attributed to the overflow bucket
    let overflowRate = allocatedRate;

    // A cascading waterfall where we allocate the new money down the list
    for (const item of list.items) {
      item.name ??= 'Item';
      item.price ??= 0;
      item.purchased ??= false;
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
    list.overflow.value = remainingMoneyToAllocate;
    list.overflow.rate = overflowRate;
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
  const items = list.items;
  const index = items.indexOf(item);

  // Remove without recovering the money
  items.splice(index, 1);

  finishedUserInteraction();
}

function addItemClick(event) {
  update();

  const list = event.target.closest(".list").list;
  list.items.push({ price: 1 });

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

function documentKeyUp(event) {
  // Ctrl+Z
  if (event.keyCode === 90 && event.ctrlKey) {
    if (event.shiftKey)
      redo();
    else
      undo();
    event.preventDefault();
    return false;
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
    set(el.textContent);
    endEdit();
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

function endEdit() {
  window.isEditing = false;
  window.elementBeingEdited = null;
  clearTimeout(window.editingTimeout);
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
  console.log('dragenter', event.target);
  if (!window.draggingItem) return;
  const itemEl = getItemElAtNode(event.target);
  if (itemEl.item === window.draggingItem) return;
  itemEl.dragOverCount = (itemEl.dragOverCount ?? 0) + 1;
  if (itemEl.dragOverCount)
    itemEl.classList.add('item-drag-over');
}

function itemDragLeave(event) {
  console.log('dragleave', event.target);
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