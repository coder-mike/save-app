# Squirrel Away

[https://squirrelaway.app](https://squirrelaway.app)

A simple web app to help to limit spending. You create a list of things you want, and specify how much money you want to budget for the list per month, and it counts money gradually towards each item until you've waited long enough to purchase it.

![screenshot](screenshot.jpg)

You create a set of lists, and set a budget for each list (how much per month you want to spend on things in that list). The app will gradually count "money" towards the first item in the list until it's "ready to buy" (meaning that you've waited long enough to purchase it) and then it will start counting money towards the second thing in the list, etc. The app does not interact with banks or real money in any way. It's merely a way to throttle your expenses so that they don't exceed some average amount (i.e. the budget amount).

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

