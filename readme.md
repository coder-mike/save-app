# Squirrel Away

[https://squirrelaway.app](https://squirrelaway.app)

A simple web app to help to limit spending. You create a list of things you want, and specify how much money you want to budget for the list per month, and it counts money gradually towards each item until you've waited long enough to purchase it.

![screenshot](screenshot.jpg)

## Usage 

You create a set of lists, and set a budget for each list (how much per month you want to spend on things in that list). The app will gradually count "money" towards the first item in the list until it's "ready to buy" (meaning that you've waited long enough to purchase it) and then it will start counting money towards the second thing in the list, etc. The app does not interact with banks or real money in any way. It's merely a way to throttle your expenses so that they don't exceed some average amount (i.e. the budget amount).

Tip: if you're playing around with the app, set the budget amount to a large a figure like $100,000 to watch the money counting faster and get a feel for it.

By default, the app uses web [localStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage). If you set up an account, it will synchronize to that account.

If all the items in a list are purchased, the app starts counting towards the list "kitty". When a new item is then added to the list, the kitty money will immediately flush into the new item.

When you purchase an item in the real world, you can mark it as purchased on the list. If you purchase an item for more than the "saved" money, the money will come out of the list kitty, putting the list into arrears (the UI will say there is an amount "owning" on the list). Money flowing into the list will first pay off this amount owing before flowing into other list items.

## Cookbook

### Intermittent expenses

You can also treat lists as accounts. For example, if I expect to pay $600/year in car maintenance, I can create a "car maintenance" list with a budget of $50/month and let the app count money towards it, without any particular items in the list to save for. Then each time I take my car in, I'll add a new item into the list and immediately mark it as "purchased". The list kitty will show how much is remaining in this "account". If I find that this list is always in arrears, I need to consider increasing the budget on the list. When I do so, I may need to decrease the budget on another listso that the total doesn't exceed my salary.

## Run

  - Clone repo
  - `npm run build` or `npm run build:watch` to build (the later will watch for changes after building), or use `ctrl+shift+B` in VSCode to build continuously in the background.
  - `npm run web-server` and open `localhost:8080` in a browser (uses web localStorage for storage)
  - OR host the `./public` files on a PHP server with `config.php` configured with the chosen database connection

## Deploy

`npm run deploy uat` or `npm run deploy prod`

Requires `deploy-config.json` to exist and have the parameters needed, e.g.:

```json
{
  "uat": {
    "ftpPath": "squirrelaway.app/public_html/uat",
    "ftpOptions": {
      "host": "squirrelaway.app",
      "port": 21,
      "user": "deploy@squirrelaway.app",
      "pass": "***"
    }
  },
  "prod": {
    "ftpPath": "squirrelaway.app/public_html",
    "ftpOptions": {
      "host": "squirrelaway.app",
      "port": 21,
      "user": "deploy@squirrelaway.app",
      "pass": "***"
    }
  }
}
```

