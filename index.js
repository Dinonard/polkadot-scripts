const { ApiPromise, WsProvider, Keyring } = require("@polkadot/api");
const { KeyringPair } = require("@polkadot/keyring/types");
const { BN } = require("bn.js");
const { encodeAddress } = require("@polkadot/util-crypto");

const fs = require("fs");
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const yargs = require("yargs");

// Can be adjusted, depending on how large the calls end up being.
const BATCH_SIZE_LIMIT = 100;

/**
 * Used to establish a connection to the API
 *
 * @param {string} endpoint - The WebSocket endpoint to connect to.
 */
async function connectApi(endpoint) {
  const wsProvider = new WsProvider(endpoint);
  const api = await ApiPromise.create({ provider: wsProvider });

  return api;
};

/**
 * Used to create a new account from a seed. If no seed is provided, it defaults to using Alice.
 *
 * @returns {KeyringPair} A keyring pair representing the created account.
 */
async function getAccount(api) {
  const keyring = new Keyring({
    type: "sr25519",
    ss58Format: api.registry.chainSS58,
  });

  const maybeSeed = process.env["SEED"];
  if (maybeSeed) {
    console.info("Creating an account from the provided seed.");
    return keyring.addFromUri(maybeSeed);
  } else {
    console.info("No seed provided, using Alice.");
    return keyring.addFromUri("//Alice");
  }
}

/**
 * This function sends a transaction and waits for it to be included in a block or finalized, depending on the `waitForFinalization` parameter.
 *
 * @param {Extrinsic} tx - The transaction to send.
 * @param {KeyringPair} signer - The account to sign the transaction with.
 * @param {boolean} [waitForFinalization=true] - Whether to wait for the transaction to be finalized before resolving the promise.
 *                                               If false, the promise is resolved as soon as the transaction is included in a block.
 * @returns {Promise<Object>} A promise that resolves to an object containing the success status, the block hash, and the events included and finalized.
 */
async function sendAndFinalize(tx, signer, options, waitForFinalization = true) {
  return new Promise((resolve) => {
    let success = false;
    let included = [];
    let finalized = [];

    const unsubPromise = tx.signAndSend(
      signer,
      options,
      ({ events = [], status, dispatchError }) => {
        if (status.isInBlock) {
          success = dispatchError ? false : true;
          console.log(
            `📀 Transaction ${tx.meta.name}(..) included at blockHash ${status.asInBlock} [success = ${success}]`
          );
          included = [...events];
          const hash = status.hash;
          if (!waitForFinalization) {
            resolve({ success, hash, included, finalized, unsubPromise });
          }
        } else if (status.isBroadcast) {
          console.log(`🚀 Transaction broadcasted.`);
        } else if (status.isFinalized) {
          console.log(
            `💯 Transaction ${tx.meta.name}(..) Finalized at blockHash ${status.asFinalized}`
          );
          finalized = [...events];
          const hash = status.hash;
          resolve({ success, hash, included, finalized, unsubPromise });
        } else if (status.isReady) {
          // ...
        } else if (status.isInvalid) {
          console.log(`🚫 Transaction ${tx.meta.name}(..) invalid`);
          success = false;
          resolve({ success, included, finalized, unsubPromise });
        } else if (status.isUsurped) {
          console.log(`👮 Transaction ${tx.meta.name}(..) usurped`);
          success = false;
          resolve({ success, included, finalized, unsubPromise });
        } else {
          console.log(`🤷 Other status ${status.toString()}`);
        }
      }
    );
  });
}

/**
 * This function retrieves all staker accounts from a Astar/Shiden/Shibuya network.
 *
 * @param {string} args.endpoint - The WebSocket endpoint to connect to.
 */
async function getAllStakers(args) {
  console.log("Preparing API used to get all staker accounts.");
  const api = await connectApi(args.endpoint);

  const pageSize = 1000;

  let stakerAccounts = [];
  let counter = 0;

  let last_key = null;
  while (true) {
    let entries = await api.query.dappsStaking.ledger.entriesPaged({
      pageSize: pageSize,
      args: [],
      startKey: last_key,
    });

    if (entries.length == 0) {
      break;
    }

    for (const accountLedger of entries) {
      const key = accountLedger[0];
      const stakerAccount = encodeAddress(key.slice(-32), 5);

      stakerAccounts.push(stakerAccount);
    }

    last_key = entries[entries.length - 1][0];

    counter++;
    if (counter % 10 == 0) {
      console.log("Processed", counter * pageSize, "accounts.");
    }
  }

  console.log("Total number of staker accounts: ", stakerAccounts.length);

  const data = JSON.stringify(stakerAccounts);
  fs.writeFileSync(args.path, data);
};


/**
 * Get the limit era for reward claiming (exclusive) for the specified smart contract.
 */
async function getLimitEra(api, smartContract, currentEra, limitErasPerContract) {
  // If the limit era for this smart contract has not been fetched yet
  if (!limitErasPerContract[smartContract]) {
    const maybeDAppInfo = await api.query.dappsStaking.registeredDapps(smartContract);

    if (maybeDAppInfo.isNone) {
      console.log("This shouldn't happen, since we are only iterating over dApps which exist in storage.");
    }
    const dAppInfo = maybeDAppInfo.unwrap();

    limitErasPerContract[smartContract] = dAppInfo.state.hasOwnProperty('unregistered') ? dAppInfo.state.unregistered.toInteger() : currentEra;
  }

  return limitErasPerContract[smartContract];
};

/**
 * This function checks if a reward switch is required for a staker.
 *
 * @param {ApiPromise} api - An instance of the API.
 * @param {Object} stakerInfo - An object containing the staker's information.
 * @param {Object} stakerLedger - An object containing the staker's ledger.
 * @param {number} currentEra - The current era.
 *
 * @returns {boolean} Returns true if a reward switch is required, false otherwise.
 */
function isRewardSwitchRequired(api, stakerInfo, stakerLedger, currentEra) {
  if (stakerLedger.reward_destination == "FreeBalance") {
    return false;
  }

  // The logic will assume `maxEraStakeValues` is equal or greater than 2, but we know for a fact it is on all of Astar-related networks.
  const MAX_ERA_STAKE_VALUES = api.consts.dappsStaking.maxEraStakeValues;

  const overflowOfEraStakeValuesExpected =
    stakerInfo.stakes.length == MAX_ERA_STAKE_VALUES &&
    (stakerInfo.stakes[0].era.toNumber() + 1) <
    stakerInfo.stakes[1].era.toNumber() &&
    stakerInfo.stakes[MAX_ERA_STAKE_VALUES - 1].era.toNumber() != currentEra;

  return overflowOfEraStakeValuesExpected;
};

/**
 * This function returns an array of calls that are needed to claim all rewards for the given staker's stake on the provided smart contract.
 * NOTE: this can change on blockchain at anytime, since anyone can claim rewards for anyone.
 *
 * @param {ApiPromise} api - An instance of the API.
 * @param {string} stakerAccount - The account of the staker.
 * @param {Object} stakerLedger - An object containing the staker's ledger.
 * @param {string} smartContract - The address of the smart contract.
 * @param {Object} stakerInfo - An object containing the staker's information.
 * @param {number} currentEra - The current era.
 * @param {boolean} dummyCalls - A flag indicating whether to generate dummy calls.
 *
 * @returns {Array} An array of calls needed to claim all rewards for the staker's stake.
 */
function getRewardClaimCalls(
  api,
  stakerAccount,
  stakerLedger,
  smartContract,
  stakerInfo,
  limitEra,
  dummyCalls,
) {
  let calls = [];
  let startIndex = 0;

  if (isRewardSwitchRequired(api, stakerInfo, stakerLedger)) {
    // 1. Switch to FreeBalance
    const setFreeBalanceTx = dummyCalls ? api.tx.dappsStaking.claimStaker(smartContract) : api.tx.dappsStaking.setRewardDestinationFor(
      stakerAccount,
      "FreeBalance"
    );
    calls.push(setFreeBalanceTx);

    // 2. Claim rewards until the number of era stake value gets reduced
    for (let inner_claim_era = stakerInfo.stakes[0].era; inner_claim_era < stakerInfo.stakes[1].era; inner_claim_era++) {
      const tx = dummyCalls ? api.tx.dappsStaking.claimStaker(smartContract) : api.tx.dappsStaking.claimStakerFor(stakerAccount, smartContract);
      calls.push(tx);
    }

    // 3. Switch back to StakeBalance
    const setStakeBalanceTx = dummyCalls ? api.tx.dappsStaking.claimStaker(smartContract) : api.tx.dappsStaking.setRewardDestinationFor(
      stakerAccount,
      "StakeBalance"
    );
    calls.push(setStakeBalanceTx);

    // Switch to second value era since we claimed all rewards from the first one to the second one (exclusive).
    startIndex = 1;
  }

  for (let entryIndex = startIndex; entryIndex < stakerInfo.stakes.length; entryIndex++) {
    const stakeEntry = stakerInfo.stakes[entryIndex];

    // In case this 'span' has no staked amount, we skip it.
    if (stakerInfo.stakes[entryIndex].staked.toBigInt() == 0) {
      continue;
    }

    // Prepare claim calls for each era in the 'span'.
    const firstEra = stakeEntry.era.toNumber();
    const endEra = parseInt((entryIndex == stakerInfo.stakes.length - 1) ? limitEra : stakerInfo.stakes[entryIndex + 1].era);
    for (let i = firstEra; i < endEra; i++) {
      const tx = dummyCalls ? api.tx.dappsStaking.claimStaker(smartContract) : api.tx.dappsStaking.claimStakerFor(stakerAccount, smartContract);
      calls.push(tx);
    }
  }

  return calls;
};

/**
 * Used to break up calls into limited size batches and submit transactions to the Tx queue..
 *
 * @param {ApiPromise} api - An instance of the API.
 * @param {Array} calls - An array of calls to be sent.
 * @param {KeyringPair} signerAccount - The account to sign the transactions with.
 *
 * @throws Will throw an error if a batch of calls fails to be finalized.
 */
async function sendBatch(api, calls, signerAccount, tip) {
  // Need to set the nonce manually, since we are sending multiple transactions.
  let nonce = await api.rpc.system.accountNextIndex(signerAccount.address);

  // Once all calls are ready, split them into batches and execute them.
  const promises = [];

  for (let idx = 0; idx < calls.length; idx += BATCH_SIZE_LIMIT) {
    // Don't use atomic batch since even if an error occurs with some call, it's better for script to keep on running.
    const batchCall = api.tx.utility.batch(calls.slice(idx, idx + BATCH_SIZE_LIMIT));
    const promise = sendAndFinalize(batchCall, signerAccount, { tip, nonce });
    promises.push(promise);

    // Add delay after each transaction to avoid nonce collision.
    // No guarantee for this to work, maybe it can be optimized to be better.
    await new Promise(resolve => setTimeout(resolve, 5000));

    nonce++;
  }

  const results = await Promise.all(promises);

  for (const result of results) {
    // This ensures we avoid memory leak, by unsubscribing from the event listener.
    if (result.unsubPromise) {
      const unsub = await result.unsubPromise;
      unsub();
    }

    if (!result.success) {
      console.log(`Claiming failed for ${signerAccount}.`);
      throw "This shouldn't happen, but if it does, fix the bug or try restarting the script!";
    }
  }
}

/**
 * This function executes delegated claiming for all staker accounts.
 *
 * @param {Object} args - An object containing the endpoint to connect to and a dummy flag.
 * @param {string} args.endpoint - The WebSocket endpoint to connect to.
 * @param {boolean} args.dummy - A flag indicating whether to generate dummy calls.
 *
 * @throws Will throw an error if a batch of calls fails to be included or finalized.
 */
async function delegatedClaiming(args) {
  console.log("Preparing API...");
  const api = await connectApi(args.endpoint);

  console.log("Getting signer account");
  const signerAccount = await getAccount(api);

  console.log("Starting with delegated claiming.");

  const currentEra = await api.query.dappsStaking.currentEra();
  console.log("Anchored at era", currentEra.toString());

  const tip = new BN(args.tip);
  console.log("Tip set to", tip.toString(), ".");

  const minimumUnclaimedEras = args.minimumUnclaimedEras;
  console.log("Minimum unclaimed eras set to", minimumUnclaimedEras, ".")

  let stakerAccounts = JSON.parse(
    fs.readFileSync(args.path, "utf8")
  );
  console.log("Loaded ", stakerAccounts.length, " staker accounts.");

  let calls = [];

  let totalCallsCounter = 0;
  let stakerCounter = 0;
  let stakersCallsForCsv = [];
  const limitErasPerContract = {};

  // Create a CSV writer
  const csvWriter = createCsvWriter({
    path: args.unclaimedCalls,
    header: [
      { id: 'stakerAccount', title: 'Staker Account' },
      { id: 'numberOfCalls', title: 'Number of Calls' },
      { id: 'stakedAmount', title: 'Staker Amount (ASTR/SDN)' },
    ],
    fieldDelimiter: ';'
  });

  for (const stakerAccount of stakerAccounts) {
    const [stakerInfos, stakerLedger] = await Promise.all([
      api.query.dappsStaking.generalStakerInfo.entries(stakerAccount),
      api.query.dappsStaking.ledger(stakerAccount)
    ]);

    stakerCounter++;
    let stakerCallsCounter = 0;

    // For each smart contract stake, prepare calls to claim all pending rewards.
    for (const [key, stakerInfo] of stakerInfos) {
      const smartContract = key.args[1];

      const limitEra = await getLimitEra(api, smartContract, currentEra, limitErasPerContract);

      const innerCalls = getRewardClaimCalls(api, stakerAccount, stakerLedger, smartContract, stakerInfo, limitEra, args.dummy);
      stakerCallsCounter += innerCalls.length;

      // Only add calls if there are enough unclaimed eras.
      // This will be used to initially target stakers with large amount of unclaimed eras.
      if (innerCalls.length > minimumUnclaimedEras) {
        calls.push(...innerCalls);
      }
    };

    totalCallsCounter += stakerCallsCounter;

    stakersCallsForCsv.push({
      stakerAccount: stakerAccount,
      numberOfCalls: stakerCallsCounter,
      stakedAmount: (stakerLedger.locked.toBigInt() / BigInt(1e18)).toString()
    });

    if (stakersCallsForCsv.length >= 100) {
      await csvWriter.writeRecords(stakersCallsForCsv);
      stakersCallsForCsv = [];
    }

    // Once we accumulate enough calls, send them.
    if (calls.length >= BATCH_SIZE_LIMIT * 10 && !args.dummy) {
      await sendBatch(api, calls, signerAccount, tip);
      calls = [];
    } else if (args.dummy) {
      calls = [];
    }

    if (stakerCounter % 10 == 0) {
      console.log("Processed", stakerCounter, "stakers.");
    }
  }

  // Make sure everything is written to the CSV file.
  await csvWriter.writeRecords(stakersCallsForCsv)
    .then(() => {
      console.log('Finished writing to CSV file.');
    });

  // In case there are some calls left, send them as well.
  if (calls.length > 0 && !args.dummy) {
    await sendBatch(api, calls, signerAccount, tip);
  }

  console.log("Delegated claiming finished. Total number of calls:", totalCallsCounter);
};

/**
 * Used to check which accounts have remaining unclaimed rewards.
 * @param {*} args 
 */
async function remainingClaimsCheck(args) {
  console.log("Preparing API...");
  const api = await connectApi(args.endpoint);

  const currentEra = await api.query.dappsStaking.currentEra();
  console.log("Current dApps staking v2 era:", currentEra.toString());

  let stakerAccounts = JSON.parse(
    fs.readFileSync(args.path, "utf8")
  );
  console.log("Loaded ", stakerAccounts.length, " staker accounts.");

  const limitErasPerContract = {};
  let errorCounter = 0;

  const allStakersInfoPromises = stakerAccounts.map(async stakerAccount => {
    const stakerInfoEntries = await api.query.dappsStaking.generalStakerInfo.entries(stakerAccount);
    return [stakerAccount, stakerInfoEntries];
  });

  const allStakersInfoEntries = await Promise.all(allStakersInfoPromises);

  for (const [stakerAccount, stakerInfoEntries] of allStakersInfoEntries) {
    for (const [key, stakerInfo] of stakerInfos) {
      const smartContract = key.args[1];
      const limitEra = await getLimitEra(api, smartContract, currentEra, limitErasPerContract);

      if (limitEra != stakerInfo.stakes[stakerInfo.stakes.length - 1].era.toNumber()) {
        console.log("Staker", stakerAccount, "has unclaimed rewards on smart contract", smartContract.toString());
        errorCounter++;
      }
    };
  }
}

/**
 * This function migrates the dapp staking.
 *
 * @param {string} args.endpoint - The WebSocket endpoint to connect to.
 *
 * @returns {Promise<void>} A promise that resolves when the migration is finished.
 *
 * @throws Will throw an error if a transaction fails to be finalized.
 */
async function migrateDappStaking(args) {
  console.log("Preparing API...");
  const api = await connectApi(args.endpoint);

  console.log("Getting account...");
  const account = getAccount(api);

  const tip = new BN(args.tip);
  console.log("Tip set to", tip.toString(), ".");

  console.log("Starting with migration.")

  let steps = 0;
  let migration_state = await api.query.dappStakingMigration.migrationStateStorage();
  console.log("Init migration state:", migration_state.toJSON());
  while (!migration_state.isFinished) {
    steps++;
    console.log("Executing step #", steps);
    const tx = api.tx.dappStakingMigration.migrate(null);
    const submitResult = await sendAndFinalize(tx, account, { tip });

    if (!submitResult.success) {
      throw "This shouldn't happen, since Tx must succeed, eventually. If it does happen, fix the bug!";
    }
    migration_state = await api.query.dappStakingMigration.migrationStateStorage();
  }

  console.log("Migration finished. It took", steps, "steps.");
};

async function main() {
  await yargs
    .options({
      // global options that apply to each command
      endpoint: {
        alias: 'e',
        description: 'the wss endpoint. It must allow unsafe RPCs.',
        default: 'ws://127.0.0.1:9944',
        string: true,
        demandOption: false,
        global: true
      },
      tip: {
        alias: 't',
        description: 'How much to tip each transaction.',
        default: 0,
        string: true,
        demandOption: false,
        global: true
      },
      finalize: {
        alias: 'f',
        description: 'Wait for transaction to be finalized, or treat block inclusion as success.',
        demandOption: false,
        boolean: true,
        default: true,
      },
    })
    .command(
      ['dapp-staking-migration'],
      'Migrate from dApps staking v2 to dApp staking v3.',
      {},
      migrateDappStaking
    )
    .command(
      ['fetch-v2-stakers'],
      'Fetch all dApps staking v2 stakers and store them into a file.',
      (yargs) => {
        return yargs.options({
          path: {
            alias: 'p',
            description: 'Path to file where to store the staker accounts.',
            demandOption: false,
            string: true,
            default: 'stakerAccounts.json'
          }
        });
      },
      getAllStakers
    )
    .command(
      ['check-remaining-stakes'],
      'Check if there are any remaining stakes to be claimed for v2 staker accounts.',
      (yargs) => {
        return yargs.options({
          path: {
            alias: 'p',
            description: 'Path to file from which to load staker accounts.',
            demandOption: false,
            string: true,
            default: 'stakerAccounts.json'
          }
        });
      },
      remainingClaimsCheck
    )
    .command(
      ['delegated-claim'],
      'Execute delegated claim for v2 staker accounts',
      (yargs) => {
        return yargs.options({
          dummy: {
            alias: 'd',
            description: 'If set, the script will not send any transactions, but will only print the number of calls that would be executed.',
            demandOption: false,
            flag: true,
          },
          path: {
            alias: 'p',
            description: 'Path to file from which to load staker accounts.',
            demandOption: false,
            string: true,
            default: 'stakerAccounts.json'
          },
          minimumUnclaimedEras: {
            alias: 'm',
            description: 'Minimum amount of unclaimed eras for a staker to be included in the list of stakers to be processed.',
            demandOption: false,
            number: true,
            default: 0
          },
          unclaimedCalls: {
            alias: 'u',
            description: 'Path to file into which unclaimed calls per account should be written.',
            demandOption: false,
            string: true,
            default: 'unclaimedCalls.csv'
          },
        });
      },
      delegatedClaiming
    )
    .parse();
}

main()
  .then(() => {
    console.info('Exiting ...');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });


// const pageSize = 1;
// let entry = await api.query.dappsStaking.generalStakerInfo.entriesPaged({
//   pageSize,
//   args: [],
//   startKey: startKey,
// });
