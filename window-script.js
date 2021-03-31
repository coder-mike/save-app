const fs = require('fs')

window.state = JSON.parse(fs.readFileSync('state.json'));
let lastCommitTime = Date.parse(window.state.time);

window.saveState = () => {
  fs.writeFileSync('state.json', JSON.stringify(window.state, null, 2))
};

window.addEventListener('load', (event) => {
  render()
});

function render() {
  console.log('s2', window.state);

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

function commitState(state) {
  const newTime = Date.now();

  const allocatedRate = getAllocatedRate(state.allocated)
  const newMoney = state.overflow.value + allocatedRate * (newTime - lastCommitTime)/86_400_000;

  // A cascading waterfall where we allocate the new money down the list
  for (const item of state.items) {
    if (newMoney && item.saved.value < item.price) {
      if (item.saved.value + newMoney < item.price) {
        item.saved.value += newMoney;
        newMoney = 0;
      } else {
        newMoney -= (item.price - item.saveState);
        item.saved.value = item.price;
      }
    }
  }

  if (newMoney) {

  }

  const model = {
    time: new Date(newTime).toISOString(),
  }
}

function getAllocatedRate(allocated) {
  if (unit === '/month')
    return allocated.dollars * 12 / 365.25;
  else
    throw new Error('Unknown unit')
}