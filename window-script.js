const fs = require('fs')

window.saveState = () => {
  fs.renameSync('state.json', `backups/state_${Math.round(Date.now())}.json.backup`)
  fs.writeFileSync('state.json', JSON.stringify(window.state, null, 2))
};

window.addEventListener('load', (event) => {
  window.state = JSON.parse(fs.readFileSync('state.json'));
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
  // For the moment I'm assuming just one list
  return renderList(state.lists[0]);
}

function renderList(list) {
  const listEl = document.createElement('div');
  listEl.classList.add('list');

  const header = document.createElement('h1');
  header.appendChild(document.createTextNode(list.name));
  listEl.appendChild(header);

  const itemsEl = document.createElement('ol');
  for (const item of list.items) {
    itemsEl.appendChild(renderItem(item));
  }
  listEl.appendChild(itemsEl);

  return listEl;
}

function renderItem(item) {
  const itemEl = document.createElement('li');

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
  const etaStr = moment(item.expectedDate).format("D MMM");
  etaEl.appendChild(document.createTextNode(etaStr));
  itemEl.appendChild(etaEl);

  return itemEl;
}

function renderAmount(amount) {
  if (!amount.rate)
    return document.createTextNode(Math.floor(amount.value));

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
          const timeUntilSaved = (item.price - item.saved.value) / allocatedRate * 86_400_000;
          if (!nextNonLinearity || timeUntilSaved < nextNonLinearity)
            nextNonLinearity = timeUntilSaved;
          newMoney = 0;
          overflowRate = 0;
        } else {
          newMoney -= (item.price - item.saveState);
          item.saved.value = item.price;
          item.saved.rate = 0;
        }
      } else {
        item.saved.rate = 0;
      }
    }

    // If there's still money left over, it goes into the overflow
    list.overflow.value = newMoney;
    list.overflow.rate = overflowRate;
  }

  state.time = new Date(newTime).toISOString();
  state.nextNonLinearity = nextNonLinearity
    ? new Date(newTime + nextNonLinearity)
    : null;

  window.state = state;
  window.nextNonLinearity = nextNonLinearity;
  window.lastCommitTime = newTime;
  render();
  window.saveState();

  if (nextNonLinearity) {
    console.log(`Next non-linearity in ${nextNonLinearity/1000}s`)
    setTimeout(() => {
      console.log('Committing at nonlinearity')
      updateState(window.state)
    }, nextNonLinearity)
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