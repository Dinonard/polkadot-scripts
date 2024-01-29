## How To Run?
* Install dependencies `yarn` or `npm install`
- run the script `yarn start --help` or `npm start --help`

## Endpoint

Connection endpoint can be passed using `-e` argument

## Account

If no account is specified as signed, by default `Alice` is used.

Seed phrase can be provided via environment variable:
- `SEED="..." yarn start ...`

## Delegated Claim

`yarn start -e ws://127.0.0.1:8000 -t 10000000000000000 delegated-claim -p stakerAccounts.json -m 500`