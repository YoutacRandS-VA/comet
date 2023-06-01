import hre from 'hardhat';
import { DeploymentManager } from '../../plugins/deployment_manager/DeploymentManager';
import {
  CometInterface,
  OnChainLiquidator
} from '../../build/types';
import {
  arbitragePurchaseableCollateral,
  liquidateUnderwaterBorrowers,
  getAssets,
  Asset
} from './liquidateUnderwaterBorrowers';
import { FlashbotsBundleProvider } from '@flashbots/ethers-provider-bundle';
import { Signer, Wallet } from 'ethers';
import googleCloudLog, { LogSeverity } from './googleCloudLog';
import { Sleuth } from '@compound-finance/sleuth';
import * as liquidatableQuerySol from '../../artifacts/contracts/LiquidatableQuery.sol/LiquidatableQuery.json';

const loopDelay = 5000;
const loopsUntilUpdateAssets = 1000;
let assets: Asset[] = [];

async function main() {
  let { DEPLOYMENT: deployment, LIQUIDATOR_ADDRESS: liquidatorAddress, USE_FLASHBOTS: useFlashbots, ETH_PK: ethPk } = process.env;
  if (!liquidatorAddress) {
    throw new Error('missing required env variable: LIQUIDATOR_ADDRESS');
  }
  if (!deployment) {
    throw new Error('missing required env variable: DEPLOYMENT');
  }
  if (useFlashbots && !ethPk) {
    throw new Error('missing required env variable: ETH_PK');
  }

  const network = hre.network.name;

  googleCloudLog(
    LogSeverity.INFO,
    `Liquidation Bot started ${JSON.stringify({network, deployment, liquidatorAddress, useFlashbots})}`
  );

  const dm = new DeploymentManager(
    network,
    deployment,
    hre,
    {
      writeCacheToDisk: false,
      verificationStrategy: 'eager',
    }
  );
  await dm.spider();

  const contracts = await dm.contracts();
  let comet = contracts.get('comet') as CometInterface;

  // Flashbots provider requires passing in a standard provider
  let flashbotsProvider: FlashbotsBundleProvider;
  let signer: Signer;

  if (useFlashbots && useFlashbots.toLowerCase() === 'true') {
    // XXX use a designated auth signer
    // `authSigner` is an Ethereum private key that does NOT store funds and is NOT your bot's primary key.
    // This is an identifying key for signing payloads to establish reputation and whitelisting
    // In production, this should be used across multiple bundles to build relationship. In this example, we generate a new wallet each time
    const authSigner = Wallet.createRandom();

    if (network === 'mainnet') {
      flashbotsProvider = await FlashbotsBundleProvider.create(
        hre.ethers.provider, // a normal ethers.js provider, to perform gas estimations and nonce lookups
        authSigner, // ethers.js signer wallet, only for signing request payloads, not transactions
      );
    } else if (network === 'goerli') {
      flashbotsProvider = await FlashbotsBundleProvider.create(
        hre.ethers.provider, // a normal ethers.js provider, to perform gas estimations and nonce lookups
        authSigner, // ethers.js signer wallet, only for signing request payloads, not transactions
        'https://relay-goerli.flashbots.net',
        'goerli'
      );
    } else {
      throw new Error(`Unsupported network: ${network}`);
    }

    // Note: A `Wallet` is used because it can sign a transaction for flashbots while a generic `Signer` cannot
    // See https://github.com/ethers-io/ethers.js/issues/1869
    signer = new Wallet(ethPk);
  } else {
    signer = await dm.getSigner();
  }

  const signerWithFlashbots = { signer, flashbotsProvider };

  // connect Comet instance to the signer, so direct calls to Comet functions have a signer
  comet = comet.connect(signer);

  if (!comet) {
    throw new Error(`no deployed Comet found for ${network}/${deployment}`);
  }

  let sleuth = new Sleuth(hre.ethers.provider);
  // Hardhat's output seems to not match Forge's, but it's a small tweak
  let liquidatableQuerySolFixed = {
    ...liquidatableQuerySol,
    evm: { bytecode: { object: liquidatableQuerySol.bytecode } }
  };
  let liquidatableQuery = await Sleuth.querySol<[string, string[]], [string[]]>(liquidatableQuerySolFixed);

  const liquidator = await hre.ethers.getContractAt(
    'OnChainLiquidator',
    liquidatorAddress,
    signer
  ) as OnChainLiquidator;

  let lastBlockNumber: number;
  let lastCheckedBlockNumber: number;
  let loops = 0;
  while (true) {
    if (assets.length == 0 || loops >= loopsUntilUpdateAssets) {
      googleCloudLog(LogSeverity.INFO, 'Updating assets');
      assets = await getAssets(comet);
      loops = 0;
    }

    // TODO: Remove this line entirely
    const currentBlockNumber = await hre.ethers.provider.getBlockNumber();

    googleCloudLog(LogSeverity.INFO, `currentBlockNumber: ${currentBlockNumber} [checked=${lastCheckedBlockNumber}]`);

    if (currentBlockNumber !== lastBlockNumber) {
      lastBlockNumber = currentBlockNumber;
      const [checkedBlockNumber, liquidationAttempted] = await liquidateUnderwaterBorrowers(
        sleuth,
        liquidatableQuery,
        comet,
        liquidator,
        signerWithFlashbots,
        network,
        deployment
      );
      lastCheckedBlockNumber = checkedBlockNumber;
      if (!liquidationAttempted) {
        await arbitragePurchaseableCollateral(
          comet,
          liquidator,
          assets,
          signerWithFlashbots,
          network,
          deployment
        );
      }
    } else {
      googleCloudLog(LogSeverity.INFO, `block already checked; waiting ${loopDelay}ms`);
      await new Promise(resolve => setTimeout(resolve, loopDelay));
    }

    loops += 1;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
