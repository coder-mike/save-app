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
  pushUndoPoint();
  update();
  render();
});

document.addEventListener('keydown', documentKeyUp);

function render() {
  const content = renderPage(window.state);
  const page = document.getElementById('page');
  page.replaceChildren(content)
}

function save() {
  console.log('Would save here'); // window.saveState(); TODO
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
  pageEl.classList.add('page-body');

  // const reloadButton = document.createElement('button');
  // reloadButton.textContent = 'Reload';
  // reloadButton.addEventListener('click', () => {
  //   updateState();
  //   window.reload();
  // })
  // pageEl.appendChild(reloadButton);

  // For the moment I'm assuming just one list
  const listEl = renderList(state.lists[0]);
  pageEl.appendChild(listEl);

  return pageEl;
}

function renderList(list) {
  const listEl = document.createElement('div');
  listEl.list = list;
  listEl.classList.add('list');

  const header = document.createElement('h1');
  header.appendChild(document.createTextNode(list.name));
  listEl.appendChild(header);

  const itemsEl = document.createElement('ol');
  for (const item of list.items) {
    itemsEl.appendChild(renderItem(item));
  }
  listEl.appendChild(itemsEl);

  const addItemEl = document.createElement('button');
  addItemEl.classList.add('add-item');
  addItemEl.textContent = 'New';
  addItemEl.addEventListener('click', addItemClick);

  listEl.appendChild(addItemEl);

  return listEl;
}

function renderItem(item) {
  const itemEl = document.createElement('li');
  itemEl.item = item;
  itemEl.style.position = 'relative';
  itemEl.classList.add('item');
  itemEl.classList.add(item.purchased ? 'purchased' : 'not-purchased')
  itemEl.classList.add(item.saved.value >= item.price ? 'afforded' : 'not-afforded')

  createItemBackground(item, itemEl);

  // Name
  const nameEl = document.createElement('div');
  nameEl.classList.add('item-name')
  nameEl.appendChild(document.createTextNode(item.name));
  itemEl.appendChild(nameEl);

  // Saved
  const savedEl = document.createElement('div');
  savedEl.classList.add('currency');
  savedEl.classList.add('saved');
  savedEl.appendChild(renderAmount(item.saved));
  itemEl.appendChild(savedEl);

  // Price
  const priceEl = document.createElement('div');
  priceEl.classList.add('currency');
  priceEl.classList.add('price');
  priceEl.appendChild(document.createTextNode(item.price));
  itemEl.appendChild(priceEl);

  // ETA
  if (item.expectedDate) {
    const etaEl = document.createElement('div');
    etaEl.classList.add('currency');
    etaEl.classList.add('eta');
    const etaStr = formatDate(item.expectedDate);
    etaEl.appendChild(document.createTextNode(etaStr));
    itemEl.appendChild(etaEl);
  }

  // Move up
  const moveUp = document.createElement('button');
  moveUp.classList.add('move-up');
  moveUp.textContent = 'Up';
  moveUp.addEventListener('click', moveUpClick)
  itemEl.appendChild(moveUp);

  // Move down
  const moveDown = document.createElement('button');
  moveDown.classList.add('move-down');
  moveDown.textContent = 'Down';
  moveDown.addEventListener('click', moveDownClick)
  itemEl.appendChild(moveDown);

  return itemEl;
}

function renderAmount(amount) {
  if (!amount.rate)
    return document.createTextNode(amount.value.toFixed(2));

  const node = document.createTextNode('')
  const update = () => {
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
      itemEl.style.background = `linear-gradient(90deg, #ddeeff ${percent}%, white ${percent}%)`
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

  const lastCommitTime = Date.parse(state.time);
  let timeOfNextNonlinearity = null;

  for (const list of state.lists) {
    list.name ??= 'List';
    list.allocated ??= { dollars: 0, unit: '/month' };
    list.overflow ??= { value: 0, rate: 0 };
    list.items ??= [];

    const allocatedRate = getAllocatedRate(list.allocated)

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
      timeCursor += remainingCost / rateInDollarsPerMs(allocatedRate);

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

function addItemClick(event) {
  update();

  const list = event.target.closest(".list").list;
  list.items.push({});

  finishedUserInteraction();
}

// For debuggability, the rates are stored in dollars per day, but we need them
// in dollars per millisecond for most calculations
function rateInDollarsPerMs(rate) {
  return rate / 86_400_000;
}

function formatDate(date) {
  const d = new Date(date);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${('0' + d.getHours()).slice(-2)}:${('0' + d.getMinutes()).slice(-2)}:${('0' + d.getSeconds()).slice(-2)}.${('00' + d.getMilliseconds()).slice(-3)}`;
}

function serializeDate(date) {
  return new Date(date).toISOString();
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