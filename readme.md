# Squirrel Away

[https://squirrelaway.app](https://squirrelaway.app)

A simple app to help to limit spending. You create a list of things you want, and specify how much money you want to budget for the list per month, and it counts money gradually towards each item until you've waited long enough to purchase it.

![screenshot](screenshot.jpg)

## Run

  - Clone repo
  - `npm run build` or `npm run build:watch` to build (the later will watch for changes after building), or use `ctrl+shift+B` in VSCode to build continuously in the background.
  - Host the `./public` files on a PHP server with `config.php` configured with the chosen database connection
  - OR `npm run web-server` and open `localhost:8080` in a browser (uses web localStorage for storage)

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

