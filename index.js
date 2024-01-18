const { ApiPromise, WsProvider, Keyring } = require("@polkadot/api");
const { KeyringPair } = require("@polkadot/keyring/types");
const { BN } = require("bn.js");
const { encodeAddress, isEthereumAddress } = require("@polkadot/util-crypto");
const fs = require("fs");

const ENDPOINT = "ws://127.0.0.1:9944";

// Can be adjusted, depending on how large the calls end up being.
const BATCH_SIZE_LIMIT = 100;

const connectApi = async () => {
  const wsProvider = new WsProvider(ENDPOINT);
  const api = await ApiPromise.create({ provider: wsProvider });

  return api;
};

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

async function sendAndFinalize(tx, signer) {
  return new Promise((resolve) => {
    let success = false;
    let included = [];
    let finalized = [];

    // Should be enough to get in front of the queue
    const tip = new BN(1_000_000_000_000_000);

    tx.signAndSend(
      signer,
      { tip },
      ({ events = [], status, dispatchError }) => {
        if (status.isInBlock) {
          success = dispatchError ? false : true;
          console.log(
            `📀 Transaction ${tx.meta.name}(..) included at blockHash ${status.asInBlock} [success = ${success}]`
          );
          included = [...events];
        } else if (status.isBroadcast) {
          console.log(`🚀 Transaction broadcasted.`);
        } else if (status.isFinalized) {
          console.log(
            `💯 Transaction ${tx.meta.name}(..) Finalized at blockHash ${status.asFinalized}`
          );
          finalized = [...events];
          const hash = status.hash;
          resolve({ success, hash, included, finalized });
        } else if (status.isReady) {
          // let's not be too noisy..
        } else {
          console.log(`🤷 Other status ${status}`);
        }
      }
    );
  });
}

// Used to get all staker accounts participating in dApps staking v2.
async function  getAllStakers () {
  console.log("Preparing API used to get all staker accounts.");
  const api = await connectApi();

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
  fs.writeFileSync("stakerAccounts.json", data);
};

// Used to check if the reward destination switch is required in order to execute a reward claim.
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

// Returns an array of calls that are needed to claim all rewards for the given staker's stake on the provided smart contract.
function getRewardClaimCalls(
  api,
  stakerAccount,
  stakerLedger,
  smartContract,
  stakerInfo,
  currentEra
) {
  let calls = [];
  let startIndex = 0;

  if (isRewardSwitchRequired(api, stakerInfo, stakerLedger)) {
    // 1. Switch to FreeBalance
    const setFreeBalanceTx = api.tx.dappsStaking.setRewardDestinationFor(
      stakerAccount,
      "FreeBalance"
    );
    calls.push(setFreeBalanceTx);

    // 2. Claim rewards until the number of era stake value gets reduced
    for (let inner_claim_era = stakerInfo.stakes[0].era; inner_claim_era < stakerInfo.stakes[1].era; inner_claim_era++) {
      const tx = api.tx.dappsStaking.claimStakerFor(stakerAccount, smartContract);
      calls.push(tx);
    }

    // 3. Switch back to StakeBalance
    const setStakeBalanceTx = api.tx.dappsStaking.setRewardDestinationFor(
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
    const firstEra = stakeEntry.era;
    const endEra = (entryIndex == stakerInfo.stakes.length - 1) ? currentEra : stakerInfo.stakes[entryIndex + 1].era;
    for (let i = firstEra; i < endEra; i++) {
      const tx = api.tx.dappsStaking.claimStakerFor(stakerAccount, smartContract);
      calls.push(tx);
    }
  }

  return calls;
};

// Execute delegated claim for all staker accounts.
const delegated_claiming = async () => {
  console.log("Preparing API...");
  const api = await connectApi();

  console.log("Getting signer account");
  const signerAccount = await getAccount(api);

  console.log("Starting with delegated claiming.");

  const currentEra = await api.query.dappsStaking.currentEra();
  console.log("Anchored at era", currentEra.toString());

  let stakerAccounts = JSON.parse(
    fs.readFileSync("stakerAccounts.json", "utf8")
  );
  console.log("Loaded ", stakerAccounts.length, " staker accounts.");

  // Process each staker account, ensure that all pending rewards are claimed.
  for (const stakerAccount of stakerAccounts) {
    // Acquire structs related to the staker account.
    const [stakerInfos, stakerLedger] = await Promise.all([
      api.query.dappsStaking.generalStakerInfo.entries(stakerAccount),
      api.query.dappsStaking.ledger(stakerAccount)
    ]);

    let innerCalls = [];

    // For each smart contract stake, prepare calls to claim all pending rewards.
    stakerInfos.forEach(([key, stakerInfo]) => {
      const smartContract = key.args[1];

      const calls = getRewardClaimCalls(api, stakerAccount, stakerLedger, smartContract, stakerInfo, currentEra);

      innerCalls.push(...calls);
    });

    // Once all calls are ready, split them into batches and execute them.
    for (let idx = 0; idx < innerCalls.length; idx += BATCH_SIZE_LIMIT) {
      const batchCall = api.tx.utility.batchAll(innerCalls.slice(idx, idx + BATCH_SIZE_LIMIT));
      const submitResult = await sendAndFinalize(batchCall, signerAccount);
      if (!submitResult.success) {
        console.log(`Claiming failed for ${stakerAccount}.`);
        throw "This shouldn't happen, but if it does, fix the bug!";
      }
    }
  }
};

async function migrate_dapp_staking() {  
  console.log("Preparing API...");
  const api = await connectApi();

  console.log("Getting account...");
  const account = await getAccount(api);

  console.log("Starting with migration.")

  let steps = 0;
  let migration_state = await api.query.dappStakingMigration.migrationStateStorage();
  console.log("Init migration state:", migration_state.toJSON());
  while (!migration_state.isFinished) {
    steps++;
    console.log("Executing step #", steps);
    const tx = api.tx.dappStakingMigration.migrate(null);
    const submitResult = await sendAndFinalize(tx, account);

    if (!submitResult.success) {
      throw "This shouldn't happen, since Tx must succeed, eventually. If it does happen, fix the bug!";
    }
    migration_state = await api.query.dappStakingMigration.migrationStateStorage();
  }

  console.log("Migration finished. It took", steps, "steps.");
};

const run = async () => {
  //   await getAllStakers();
  await delegated_claiming();
  // await migrate_dapp_staking();
  process.exit();
};

run();

// const pageSize = 1;
// let entry = await api.query.dappsStaking.generalStakerInfo.entriesPaged({
//   pageSize,
//   args: [],
//   startKey: startKey,
// });
