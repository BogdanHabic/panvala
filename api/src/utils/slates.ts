import * as ethers from 'ethers';
import * as ipfs from './ipfs';
import { range } from 'lodash';
import * as Bluebird from 'bluebird';
import { Schema } from 'express-validator';

import { getContracts } from './eth';
import * as config from './config';
import { nonEmptyString } from './validation';
import { getProposalsForRequests } from './requests';
import { mapProposalsToRequests } from './proposals';
import { BigNumberish, bigNumberify } from 'ethers/utils';

const { IpfsMetadata, Slate } = require('../models');
const { toUtf8String, bigNumberify: BN, getAddress } = ethers.utils;
const { tokenCapacitorAddress } = config.contracts;

/**
 * Read slate info from the blockchain, IPFS, and the local DB
 */
async function getAllSlates() {
  // Get an interface to the Gatekeeper, ParameterStore contracts
  const { provider, gatekeeper, parameterStore } = await getContracts();

  // Get the slate staking requirement
  const requiredStake = await parameterStore.functions.get('slateStakeAmount');

  // Get the number of available slates
  const slateCount = await gatekeeper.functions.slateCount();
  console.log(`fetching ${slateCount} slates`);
  const currentEpoch = await gatekeeper.functions.currentEpochNumber();
  console.log('currentEpoch:', currentEpoch);

  let grantsIncumbent, governanceIncumbent: string | undefined;
  if (gatekeeper.functions.hasOwnProperty('incumbent')) {
    [grantsIncumbent, governanceIncumbent] = await Promise.all([
      gatekeeper.functions.incumbent(tokenCapacitorAddress),
      gatekeeper.functions.incumbent(parameterStore.address),
    ]);
  }

  // 0..slateCount
  const slateIDs = range(0, slateCount.toNumber());
  console.log('slateIDs', slateIDs);

  // TEMPORARY HACK
  let slateIDsToQuery = slateIDs;
  const network = await provider.getNetwork();
  if (
    network.chainId === 4 &&
    gatekeeper.address === '0xe944C83D35B404610a82166c23B17F33d6399343'
  ) {
    const garbage = [0, 1, 2, 3, 5];
    const filtered = slateIDs.filter(id => !garbage.includes(id));
    slateIDsToQuery = filtered;
  }

  const slates = await Bluebird.map(
    slateIDsToQuery,
    async (slateID, index) => {
      if (index !== 0) await Bluebird.delay(1000);
      // console.log('slateID:', slateID);
      const slate = await gatekeeper.slates(slateID);
      // const dbSlate = await Request.findOrCreate({ where: {} });
      // decode hash
      const decoded = toUtf8String(slate.metadataHash);
      // console.log('decoded hash', decoded);
      let incumbent = false;
      if (slate.recommender === grantsIncumbent && slate.resource === tokenCapacitorAddress) {
        incumbent = true;
      } else if (
        slate.recommender === governanceIncumbent &&
        slate.resource === parameterStore.address
      ) {
        incumbent = true;
      }

      // Manual slate rejection criteria:
      // (1) from previous epoch, (2) not-accepted, (3) no-contest || contest finalized
      if (BN(slate.epochNumber).lt(currentEpoch)) {
        // Unstaked
        if (slate.status === 0) {
          slate.status = 3;
        }
        // Staked
        if (slate.status === 1) {
          const contestStatus = await gatekeeper.contestStatus(slate.epochNumber, slate.resource);
          const contestSlates = await gatekeeper.contestSlates(slate.epochNumber, slate.resource);
          // No contest || contest finalized
          if (contestStatus !== 2 && contestSlates.length > 1) {
            slate.status = 3;
          }
        }
      }

      return getSlateWithMetadata(slateID, slate, decoded, incumbent, requiredStake);
    },
    { concurrency: 5 }
  );

  return slates;
}

/**
 * Get the slate metadata by combining data from multiple sources
 * @param {ethers.Contract} slate
 * @param {Number} slateID
 * @param {String} metadataHash
 * @param {Boolean} incumbent
 * @param {ethers.BigNumber} requiredStake
 */
async function getSlateWithMetadata(slateID, slate, metadataHash, incumbent, requiredStake) {
  try {
    // the slate as it exists in the db:
    const [dbSlate] = await Slate.findOrBuild({
      where: {
        slateID: slateID,
      },
      defaults: {
        slateID: slateID,
        metadataHash,
        email: '',
        verifiedRecommender: false,
      },
    });

    console.log();
    console.log('getting slate metadata:', metadataHash);
    // --------------------------
    // IPFS -- slate metadata
    // --------------------------
    let slateMetadata;
    try {
      const dbIpfsMetadata = await IpfsMetadata.findOne({
        where: {
          multihash: metadataHash,
        },
        raw: true,
      });
      slateMetadata = dbIpfsMetadata.data;
    } catch (error) {
      console.log('Slate metadata not found in db. Getting from ipfs..');
      slateMetadata = await ipfs.get(metadataHash, { json: true });
      // write to db since there's not a row already
      await IpfsMetadata.create({
        multihash: metadataHash,
        data: slateMetadata,
      });
    }

    const {
      category,
      firstName,
      lastName,
      proposals,
      description,
      organization,
      proposalMultihashes,
    } = await normalizeMetadata(slateMetadata, slate.resource);

    // console.log('proposalMultihashes:', proposalMultihashes);
    // console.log('');

    const proposalsWithIds = await mapProposalsToRequests(proposals, proposalMultihashes);

    // --------------------------
    // COMBINE/RETURN SLATE DATA
    // --------------------------
    const slateData = {
      id: slateID, // should we call this slateID instead of id? we're already using slateID as the primary key in the slates table
      category,
      epochNumber: slate.epochNumber.toNumber(),
      incumbent,
      description,
      metadataHash,
      organization,
      // either first + last name or just first name
      owner: lastName ? `${firstName} ${lastName}` : firstName,
      proposals: proposalsWithIds,
      proposalMultihashes,
      recommender: slate.recommender,
      requiredStake,
      stake: slate.stake,
      staker: slate.staker,
      status: slate.status,
      verifiedRecommender: dbSlate.verifiedRecommender,
    };
    return slateData;
  } catch (error) {
    console.log('ERROR: while combining slate with metadata:', error.message);
    throw error;
  }
}

async function normalizeMetadata(slateMetadata, resource) {
  const {
    firstName,
    lastName,
    proposals,
    description,
    organization,
    proposalMultihashes,
  } = slateMetadata;

  const { requestIDs } = slateMetadata;

  let category = 'GOVERNANCE';
  if (getAddress(resource) === getAddress(tokenCapacitorAddress)) {
    category = 'GRANT';
  }

  // is governance v1 - has `resource` and `requestIDs` keys (and summary instead of description)
  if (slateMetadata.resource != null && requestIDs != null) {
    // get the associated proposals from the database
    const rawProposals = await getProposalsForRequests(resource, requestIDs);
    const multihashes = rawProposals.map(p => toUtf8String(p.metadataHash));

    // get parameter changes - key, type, oldValue, newValue
    const proposals = await Promise.all(
      rawProposals.map(p => {
        const { metadataHash } = p;
        // TODO: handle empty oldValue
        return ipfs.findOrSaveIpfsMetadata(metadataHash).then(metadata => {
          const { parameterChanges } = metadata.data;
          return {
            parameterChanges,
          };
        });
      })
    );

    return {
      category,
      firstName,
      lastName,
      description: slateMetadata.summary,
      organization,
      proposals,
      proposalMultihashes: multihashes,
    };
  }

  // is a regular grant or updated governance
  return {
    category,
    firstName,
    lastName,
    description,
    organization,
    proposals,
    proposalMultihashes,
  };
}

export async function getWinningSlate(slates?: any[], epochNumber?: BigNumberish) {
  if (!slates) {
    slates = await getAllSlates();
  }
  const { gatekeeper } = await getContracts();
  if (!epochNumber) {
    epochNumber = await gatekeeper.currentEpochNumber();
  } else {
    epochNumber = bigNumberify(epochNumber);
  }

  if (epochNumber.lt(1)) {
    throw new Error('epoch number cannot be less than 1');
  }
  const lastEpochNumber = epochNumber.sub(1);
  try {
    const winningSlateID = await gatekeeper.getWinningSlate(lastEpochNumber, tokenCapacitorAddress);
    return slates.find(slate => slate.id === winningSlateID.toNumber());
  } catch (error) {
    console.log('Error getting winning slate:', error);
    throw error;
  }
}

/**
 * Data received in a POST request
 */
const slateSchema: Schema = {
  slateID: {
    in: ['body'],
    exists: true,
    // parse as integer
    toInt: true,
    isInt: true,
  },
  metadataHash: {
    in: ['body'],
    exists: true,
    ...nonEmptyString,
  },
  email: {
    in: ['body'],
    trim: true,
    // is a valid email if present
    isEmail: true,
    optional: {
      options: {
        // Allow empty emails
        checkFalsy: true,
      },
    },
  },
};

export { getAllSlates, slateSchema };
