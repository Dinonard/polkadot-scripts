## How To Run?
* Install dependencies `yarn` or `npm install`
* run the script `yarn start --help` or `npm start --help`

## Endpoint

Connection endpoint can be passed using `-e` argument

## Account

If no account is specified as signed, by default `Alice` is used.

Seed phrase can be provided via environment variable:
* `SEED="..." yarn start ...`

## Staker List

Prior to executing delegated claiming, list of stakers has to be fetched.

`yarn start -e ws://127.0.0.1:8000 fetch-v2-stakers -p staker_accounts.json`

This list can later be reused when restarting the script.
Once decommission mode has been activated, this script should be re-run.

It doesn't take long to fetch all stakers but it can result in lots of queries so it's important the endpoint
allows it (no rate limiter).

## Delegated Claim

Delegated claim will take days to complete since there are lots of unclaimed eras for both Astar and Shiden.

Important parameters are:
* `-t`: how much tip is added to the each transaction
* `-p`: list of staker accounts for which the rewards should be claimed
* `-m`: minimum amount of unclaimed eras an account must have to be eligible for delegated claiming. Useful in order to first focus on the inactive users, without touching the active ones.

`yarn start -e ws://127.0.0.1:8000 -t 10000000000000000 delegated-claim -p staker_accounts.json -m 500`

### Additional Safety Mechanism

It is possible that script fails at some point, due to nonce collision.
To prevent no claim calls being made for a prolonged period, as an additional measure, it's suggested to run the command
withing the provided `repeat.sh` script.

`./repeat.sh "yarn start -e ws://127.0.0.1:8000 -t 10000000000000000 delegated-claim -p staker_accounts.json -m 500"`

In case of failure, script will sleep for some time, before attempting to restart the execution again.
Number of retries is limited so script progress should still be checked from time to time.


## Migration v2 to v3

Used to migrate from dApps staking v2 over to dApp Staking v3.

`yarn start -e ws://127.0.0.1:8000 -t 100000000000000000 dapp-staking-migration`
