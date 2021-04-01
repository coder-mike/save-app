const fs = require('fs')

window.saveState = () => {
  fs.renameSync('state.json', `backups/state_${Math.round(Date.now())}.json.backup`)
  fs.writeFileSync('state.json', JSON.stringify(window.state, null, 2))
};

window.addEventListener('load', (event) => {
  window.state = JSON.parse(fs.readFileSync('state.json'));
  // For the sake of debugging, we revert the state to the last committed state
  window.state.time = new Date().toISOString();
  updateState();
});

window.willQuit = () => {
  updateState();
}

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
  const etaEl = document.createElement('div');
  etaEl.classList.add('currency');
  etaEl.classList.add('eta');
  const etaStr = moment(item.expectedDate).format("D MMM HH:mm:ss");
  etaEl.appendChild(document.createTextNode(etaStr));
  itemEl.appendChild(etaEl);

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
    const value = amount.value + amount.rate * (Date.now() - lastCommitTime)/86_400_000;
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
      const value = amount.value + amount.rate * (Date.now() - lastCommitTime)/86_400_000;
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

function updateState() {
  let state = window.state;

  state ??= {};
  state.time ??= new Date().toISOString();
  state.nextNonLinearity ??= null;
  state.lists ??= [];

  const lastCommitTime = Date.parse(state.time);
  const newTime = Date.now();
  let nextNonLinearity = null;

  for (const list of state.lists) {
    list.name ??= 'List';
    list.allocated ??= { dollars: 0, unit: '/month' };
    list.overflow ??= { value: 0, rate: 0 };
    list.items ??= [];

    const allocatedRate = getAllocatedRate(list.allocated)

    // The money we have towards the list includes anything from the previous
    // overflow plus new money accumulated since then
    let newMoney = list.overflow.value + allocatedRate * (newTime - lastCommitTime) / 86_400_000;
    let overflowRate = allocatedRate;
    let dateCursor = lastCommitTime;

    // A cascading waterfall where we allocate the new money down the list
    for (const item of list.items) {
      item.name ??= 'Item';
      item.price ??= 0;
      item.purchased ??= false;
      item.saved ??= { value: 0, rate: 0 };

      if (item.saved.value < item.price) {
        dateCursor += (item.price - item.saved.value) / allocatedRate * 86_400_000;
        item.expectedDate = new Date(dateCursor).toISOString();
        if (item.saved.value + newMoney < item.price) {
          item.saved.value += newMoney;
          item.saved.rate = overflowRate;
          const timeUntilSaved = dateCursor - lastCommitTime;
          if (!nextNonLinearity || timeUntilSaved < nextNonLinearity)
            nextNonLinearity = timeUntilSaved;
          newMoney = 0;
          overflowRate = 0;
        } else {
          newMoney -= (item.price - item.saved.value);
          item.saved.value = item.price;
          item.saved.rate = 0;
        }
      } else {
        item.saved.rate = 0;
        // For the rare case where the price drops
        newMoney += (item.saved.value - item.price);
      }
    }

    // If there's still money left over, it goes into the overflow
    list.overflow.value = newMoney;
    list.overflow.rate = overflowRate;
  }

  state.time = new Date(newTime).toISOString();
  state.nextNonLinearity = nextNonLinearity
    ? new Date(newTime + nextNonLinearity).toISOString()
    : null;

  window.state = state;
  window.nextNonLinearity = nextNonLinearity;
  window.lastCommitTime = newTime;
  render();
  //window.saveState(); TODO

  if (nextNonLinearity) {
    let timeoutPeriod = Date.parse(state.nextNonLinearity) - Date.now();
    console.log(`Next nonlinearity in ${timeoutPeriod/1000}s`)

    window.nextNonLinearityTimer && clearTimeout(window.nextNonLinearityTimer);
    if (timeoutPeriod > 2147483647)
      timeoutPeriod = 2147483647
    window.nextNonLinearityTimer = setTimeout(() => {
      console.log('Committing at nonlinearity')
      updateState(window.state)
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

  updateState();
}

function moveDownClick(event) {
  updateState();

  const item = event.target.closest(".item").item;
  const list = event.target.closest(".list").list;
  const items = list.items;
  const index = items.indexOf(item);
  items.splice(index, 1);
  items.splice(index + 1, 0, item);

  updateState();
}

function addItemClick(event) {
  updateState();

  const list = event.target.closest(".list").list;
  list.items.push({});

  updateState();

}