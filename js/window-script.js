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
  window.state.time = serializeDate(Date.now());
  window.currentListIndex = 0;

  pushUndoPoint();
  update();
  render();
});

document.addEventListener('keydown', documentKeyUp);

function render() {
  const content = renderPage(window.state);
  document.body.replaceChildren(...content)
}

function save() {
  // console.log('Would save here');
  window.saveState();
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
  const elements = [];
  elements.push(renderNavigator(state));
  elements.push(renderList(state.lists[window.currentListIndex]));
  return elements;
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
    itemEl.classList.add(i === window.currentListIndex ? 'active' : 'not-active');
    itemEl.addEventListener('click', navListItemClick);

    const nameEl = itemEl.appendChild(document.createElement('h1'));
    nameEl.textContent = list.name;

    const allocatedEl = itemEl.appendChild(document.createElement('div'));
    allocatedEl.textContent = `$${Math.round(getAllocatedRate(list.allocated) * 365.25 / 12)} / month`;

  }

  const newListButton = navEl.appendChild(document.createElement('button'));
  newListButton.textContent = 'New list';
  newListButton.addEventListener('click', newListClick);

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
  addItemEl.classList.add('add-item');
  addItemEl.textContent = 'New';
  addItemEl.addEventListener('click', addItemClick);

  return listEl;
}

function renderItem(item) {
  const itemEl = document.createElement('li');
  itemEl.item = item;
  itemEl.style.position = 'relative';
  itemEl.classList.add('item');
  if (item.purchased)
    itemEl.classList.add('purchased')
  if (item.price > 0 && item.saved.value >= item.price)
    itemEl.classList.add('afforded')
  if (item.saved.value > 0 && item.saved.value < item.price)
    itemEl.classList.add('partial-progress')

  createItemBackground(item, itemEl);

  // Name
  const nameEl = itemEl.appendChild(document.createElement('div'));
  nameEl.classList.add('item-name')
  makeEditable(nameEl, () => item.name, v => item.name = v);

  // Saved
  const savedEl = itemEl.appendChild(document.createElement('div'));
  savedEl.classList.add('currency');
  savedEl.classList.add('saved');
  savedEl.appendChild(renderAmount(item.saved));

  // Price
  const priceEl = itemEl.appendChild(document.createElement('div'));
  makeEditable(priceEl, () => formatCurrency(item.price), v => item.price = parseCurrency(v))
  priceEl.classList.add('currency');
  priceEl.classList.add('price');

  // ETA
  const etaEl = itemEl.appendChild(document.createElement('div'));
  etaEl.classList.add('eta');
  const etaStr = item.expectedDate
    ? formatDate(parseDate(item.expectedDate))
    : 'Ready';
  etaEl.appendChild(document.createTextNode(etaStr));

  // Move up
  const moveUp = itemEl.appendChild(document.createElement('button'));
  moveUp.classList.add('move-up');
  moveUp.textContent = 'Up';
  moveUp.addEventListener('click', moveUpClick)

  // Move down
  const moveDown = itemEl.appendChild(document.createElement('button'));
  moveDown.classList.add('move-down');
  moveDown.textContent = 'Down';
  moveDown.addEventListener('click', moveDownClick)

  // Delete
  const deleteEl = itemEl.appendChild(document.createElement('button'));
  deleteEl.classList.add('delete-item');
  deleteEl.textContent = 'Delete';
  deleteEl.addEventListener('click', deleteItemClick)

  return itemEl;
}

function renderAmount(amount) {
  if (!amount.rate)
    return document.createTextNode(formatCurrency(amount.value));

  const node = document.createTextNode('')
  const update = () => {
    if (window.isEditing) return;
    const value = amount.value + rateInDollarsPerMs(amount.rate) * (Date.now() - lastCommitTime);
    node.nodeValue = value.toFixed(4)
  }
  update();
  // The amount of time it takes to tick 100th of 1 cent
  const interval = 86400000 / (amount.rate * 10000);
  const timer = setInterval(update, interval)
  node.addEventListener('DOMNodeRemoved', () => {
    clearInterval(timer);
  })

  return node;
}

function createItemBackground(item, itemEl) {
  const amount = item.saved;
  // This function creates the moving background div to indicate progress, which
  // only applies
  if (amount.rate || (amount.value > 0 && amount.value < item.price)) {
    const update = () => {
      const value = amount.value + rateInDollarsPerMs(amount.rate) * (Date.now() - lastCommitTime);
      const percent = (value / item.price) * 100;
      itemEl.style.background = `linear-gradient(90deg, #c6dfe9 ${percent}%, white ${percent}%)`
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

function moveUpClick(event) {
  update();

  const item = event.target.closest(".item").item;
  const list = event.target.closest(".list").list;
  const items = list.items;
  const index = items.indexOf(item);
  items.splice(index, 1);
  items.splice(index - 1, 0, item);

  finishedUserInteraction();
}

function moveDownClick(event) {
  update();

  const item = event.target.closest(".item").item;
  const list = event.target.closest(".list").list;
  const items = list.items;
  const index = items.indexOf(item);
  items.splice(index, 1);
  items.splice(index + 1, 0, item);

  finishedUserInteraction();
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
  window.currentListIndex = index;

  render();
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
  window.state.lists.push({});
  window.currentListIndex = window.state.lists.length - 1;
  update();
  render();
}

function parseCurrency(value) {
  return Math.max(parseFloat(value) || 0, 0)
}