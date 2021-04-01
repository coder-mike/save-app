const fs = require('fs')

window.saveState = () => {
  fs.renameSync('state.json', `backups/state_${Math.round(Date.now())}.json.backup`)
  fs.writeFileSync('state.json', JSON.stringify(window.state, null, 2))
};

window.addEventListener('load', (event) => {
  window.state = JSON.parse(fs.readFileSync('state.json'));
  // For the sake of debugging, we revert the state to the last committed state
  window.state.time = serializeDate(Date.now());
  updateState();
  render();
});

function render() {
  const content = renderPage(window.state);
  const page = document.getElementById('page');
  page.replaceChildren(content)
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
    const backgroundDiv = document.createElement('div');
    backgroundDiv.classList.add('progress-background');
    backgroundDiv.style.position = 'relative';
    backgroundDiv.style.top = '0';
    backgroundDiv.style.left = '0';
    backgroundDiv.style.height = '5px';
    backgroundDiv.style.backgroundColor = 'pink';
    itemEl.appendChild(backgroundDiv);

    const update = () => {
      const value = amount.value + rateInDollarsPerMs(amount.rate) * (Date.now() - lastCommitTime);
      const percent = (value / item.price) * 100;
      backgroundDiv.style.width = `${percent}%`;
    }

    update();

    if (amount.rate) {
      // The amount of time it takes to move 1000th of the price
      const interval = 86400000 / (amount.rate * 1000);
      const timer = setInterval(update, interval)
      backgroundDiv.addEventListener('DOMNodeRemoved', () => {
        clearInterval(timer);
      })
    }
  }
}

function updateStateAndSave() {
  updateState();
  render();

  console.log('Would save here'); // window.saveState(); TODO
}

// Updates the state to the latest projected values and sets a timeout to repeat
// automatically the next time that the state needs to change
function updateState() {
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
        if (timeCursor > newTime && (!timeOfNextNonlinearity || timeCursor < timeOfNextNonlinearity))
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
    window.nextNonLinearityTimer = setTimeout(() => {
      console.log('Updating at nonlinearity')
      updateState(window.state);
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
  updateState();

  const item = event.target.closest(".item").item;
  const list = event.target.closest(".list").list;
  const items = list.items;
  const index = items.indexOf(item);
  items.splice(index, 1);
  items.splice(index - 1, 0, item);

  updateStateAndSave();
}

function moveDownClick(event) {
  updateState();

  const item = event.target.closest(".item").item;
  const list = event.target.closest(".list").list;
  const items = list.items;
  const index = items.indexOf(item);
  items.splice(index, 1);
  items.splice(index + 1, 0, item);

  updateStateAndSave();
}

function addItemClick(event) {
  updateState();

  const list = event.target.closest(".list").list;
  list.items.push({});

  updateStateAndSave();
}

// For debuggability, the rates are stored in dollars per day, but we need them
// in dollars per millisecond for most calculations
function rateInDollarsPerMs(rate) {
  return rate / 86_400_000;
}

function formatDate(date) {
  const d = new Date(date);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${("0" + d.getHours()).slice(-2)}:${("0" + d.getMinutes()).slice(-2)}:${("0" + d.getSeconds()).slice(-2)}`;
}

function serializeDate(date) {
  return new Date(date).toISOString();
}