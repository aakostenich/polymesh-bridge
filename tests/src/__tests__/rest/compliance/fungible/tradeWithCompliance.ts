import { BigNumber } from '@polymeshassociation/polymesh-sdk';
import { ClaimType, InstructionStatus } from '@polymeshassociation/polymesh-sdk/types';

import { assertTagPresent } from '~/assertions';
import { TestFactory } from '~/helpers';
import { RestClient } from '~/rest';
import { createAssetParams } from '~/rest/assets/params';
import { createClaimParams } from '~/rest/claims/params';
import { ProcessMode, TxBase } from '~/rest/common';
import { blockedIdentityRequirements, complianceRequirementsParams } from '~/rest/compliance';
import { Identity } from '~/rest/identities/interfaces';
import { PostResult } from '~/rest/interfaces';
import { fungibleInstructionParams, venueParams } from '~/rest/settlements/params';
import {
  awaitMiddlewareSyncedForRestApi,
  createVenueInstruction,
  getInstructionId,
  isAlreadyAffirmedError,
  isInstructionPurgedError,
  isRestError,
} from '~/util';

const handles = ['issuer', 'blocked', 'investor'];
let factory: TestFactory;

describe('Compliance Requirements for Fungible Assets', () => {
  let restClient: RestClient;
  let signer: string;
  let issuer: Identity;
  let blocked: Identity;
  let investor: Identity;
  let assetId: string;
  let signerTxBase: TxBase;
  let investorTxBase: TxBase;
  let blockedTxBase: TxBase;
  let venueId: string;
  let blockedBalance = 0;
  let investorBalance = 0;
  let investorInstructionId: string | undefined;
  let blockedInstructionId: string | undefined;

  beforeAll(async () => {
    factory = await TestFactory.create({ handles });
    ({ restClient } = factory);
    issuer = factory.getSignerIdentity(handles[0]);
    blocked = factory.getSignerIdentity(handles[1]);
    investor = factory.getSignerIdentity(handles[2]);

    signer = issuer.signer;
    signerTxBase = { options: { signer, processMode: ProcessMode.Submit } };
    investorTxBase = {
      options: { signer: investor.signer, processMode: ProcessMode.Submit },
    };
    blockedTxBase = {
      options: { signer: blocked.signer, processMode: ProcessMode.Submit },
    };

    assetId = await restClient.assets.createAndGetAssetId(createAssetParams(signerTxBase));
    const venueData = await restClient.settlements.createVenue(venueParams(signerTxBase));
    ({ venue: venueId } = venueData as { venue: string });
  });

  afterAll(async () => {
    await factory.close();
  });

  it('should be able to create an instruction when no compliance rules exist', async () => {
    const { result: investorInstruction } = await createVenueInstruction(
      restClient,
      factory.polymeshSdk,
      venueId,
      fungibleInstructionParams(assetId, issuer.did, investor.did, signerTxBase)
    );
    const { result: blockedReceiverInstruction } = await createVenueInstruction(
      restClient,
      factory.polymeshSdk,
      venueId,
      fungibleInstructionParams(assetId, issuer.did, blocked.did, signerTxBase)
    );

    if (!isInstructionPurgedError(investorInstruction)) {
      expect(investorInstruction).toEqual(
        assertTagPresent(expect, 'settlement.addAndAffirmWithMediators')
      );
    }
    if (!isInstructionPurgedError(blockedReceiverInstruction)) {
      expect(blockedReceiverInstruction).toEqual(
        assertTagPresent(expect, 'settlement.addAndAffirmWithMediators')
      );
    }

    investorInstructionId = getInstructionId(investorInstruction);
    blockedInstructionId = getInstructionId(blockedReceiverInstruction);
  });

  it('should be able to affirm an instruction when no compliance rules exist', async () => {
    blockedBalance += 10;
    investorBalance += 10;

    if (investorInstructionId) {
      const investorAffirmResult = await restClient.settlements.affirmInstruction(
        investorInstructionId,
        investorTxBase
      );

      if (!isAlreadyAffirmedError(investorAffirmResult)) {
        expect(investorAffirmResult).toEqual(
          assertTagPresent(expect, 'settlement.affirmInstructionWithCount')
        );
      }
    }

    if (blockedInstructionId) {
      const blockedAffirmResult = await restClient.settlements.affirmInstruction(
        blockedInstructionId,
        blockedTxBase
      );

      if (!isAlreadyAffirmedError(blockedAffirmResult)) {
        expect(blockedAffirmResult).toEqual(
          assertTagPresent(expect, 'settlement.affirmInstructionWithCount')
        );
      }
    }
  });

  it('should have transferred the asset to both receivers', async () => {
    const investorPortfolio = await restClient.portfolios.getPortfolio(investor.did, '0');

    expect(investorPortfolio).toEqual(
      expect.objectContaining({
        assetBalances: expect.arrayContaining([
          expect.objectContaining({
            asset: assetId,
            free: investorBalance.toString(),
          }),
        ]),
      })
    );

    const blockedDidPortfolio = await restClient.portfolios.getPortfolio(blocked.did, '0');

    expect(blockedDidPortfolio).toEqual(
      expect.objectContaining({
        assetBalances: expect.arrayContaining([
          expect.objectContaining({
            asset: assetId,
            free: blockedBalance.toString(),
          }),
        ]),
      })
    );
  });

  it('should be able to create compliance requirements for trading', async () => {
    const params = complianceRequirementsParams(
      [blockedIdentityRequirements(assetId, issuer.did)],
      signerTxBase
    );
    const txData = await restClient.compliance.setRequirements(assetId, params);

    expect(txData).toEqual(assertTagPresent(expect, 'complianceManager.replaceAssetCompliance'));

    const requirements = await restClient.compliance.getComplianceRequirements(assetId);

    expect(requirements).toMatchObject({
      requirements: expect.arrayContaining([
        expect.objectContaining({ conditions: params.requirements[0] }),
      ]),
    });
  });

  it('should be able to block an identity', async () => {
    const claimParams = createClaimParams({
      options: { processMode: ProcessMode.Submit, signer },
      claims: [
        {
          target: blocked.did,
          claim: {
            type: ClaimType.Blocked,
            scope: {
              type: 'Asset',
              value: assetId,
            },
          },
        },
      ],
    });
    const txData = await restClient.claims.addClaim(claimParams);

    expect(txData).toEqual(assertTagPresent(expect, 'identity.addClaim'));
  });

  it('should be able to create instruction for investor and blocked receiver', async () => {
    investorBalance += 10;

    const { result: investorInstruction, instructionId: investorId } = await createVenueInstruction(
      restClient,
      factory.polymeshSdk,
      venueId,
      fungibleInstructionParams(assetId, issuer.did, investor.did, signerTxBase)
    );

    const { result: blockedReceiverInstruction, instructionId: blockedId } =
      await createVenueInstruction(
        restClient,
        factory.polymeshSdk,
        venueId,
        fungibleInstructionParams(assetId, issuer.did, blocked.did, {
          options: { signer: issuer.signer, processMode: ProcessMode.Submit },
        })
      );

    if (!isInstructionPurgedError(investorInstruction)) {
      expect(investorInstruction).toEqual(
        assertTagPresent(expect, 'settlement.addAndAffirmWithMediators')
      );
    }

    if (!isInstructionPurgedError(blockedReceiverInstruction)) {
      expect(blockedReceiverInstruction).toEqual(
        assertTagPresent(expect, 'settlement.addAndAffirmWithMediators')
      );
    }

    investorInstructionId = investorId ?? getInstructionId(investorInstruction);
    blockedInstructionId = blockedId ?? getInstructionId(blockedReceiverInstruction);
  });

  it('should be able to call affirm on instruction for both receivers', async () => {
    let investorAffirmResult: PostResult | undefined;
    let blockedAffirmResult: PostResult | undefined;

    if (investorInstructionId) {
      investorAffirmResult = await restClient.settlements.affirmInstruction(
        investorInstructionId,
        investorTxBase
      );

      if (!isAlreadyAffirmedError(investorAffirmResult)) {
        expect(investorAffirmResult).toEqual(
          assertTagPresent(expect, 'settlement.affirmInstructionWithCount')
        );
      }
    }

    if (blockedInstructionId) {
      blockedAffirmResult = await restClient.settlements.affirmInstruction(
        blockedInstructionId,
        blockedTxBase
      );

      if (!isAlreadyAffirmedError(blockedAffirmResult)) {
        expect(blockedAffirmResult).toEqual(
          assertTagPresent(expect, 'settlement.affirmInstructionWithCount')
        );
      }
    }

    if (investorAffirmResult && !isAlreadyAffirmedError(investorAffirmResult)) {
      await awaitMiddlewareSyncedForRestApi(investorAffirmResult, restClient, new BigNumber(1));
    }
    if (blockedAffirmResult && !isAlreadyAffirmedError(blockedAffirmResult)) {
      await awaitMiddlewareSyncedForRestApi(blockedAffirmResult, restClient, new BigNumber(1));
    }
  });

  it('should have transferred asset to investor', async () => {
    const investorPortfolio = await restClient.portfolios.getPortfolio(investor.did, '0');

    expect(investorPortfolio).toEqual(
      expect.objectContaining({
        assetBalances: expect.arrayContaining([
          expect.objectContaining({
            asset: assetId,
            free: investorBalance.toString(),
          }),
        ]),
      })
    );
  });

  it('should have not transferred the asset to a blocked receiver', async () => {
    const blockedDidPortfolio = await restClient.portfolios.getPortfolio(blocked.did, '0');

    expect(blockedDidPortfolio).toEqual(
      expect.objectContaining({
        assetBalances: expect.arrayContaining([
          expect.objectContaining({
            asset: assetId,
            free: blockedBalance.toString(),
          }),
        ]),
      })
    );
  });

  it('should have affirmed the instruction for investor', async () => {
    if (!investorInstructionId) {
      const investorPortfolio = await restClient.portfolios.getPortfolio(investor.did, '0');
      expect(investorPortfolio.assetBalances.find((b) => b.asset === assetId)?.free).toBe(
        investorBalance.toString()
      );
      return;
    }

    const instruction = await restClient.settlements.getInstruction(investorInstructionId);

    expect(instruction).toEqual(
      expect.objectContaining({
        status: InstructionStatus.Success,
      })
    );
  });

  it('should have failed the instruction for blocked did', async () => {
    if (!blockedInstructionId) {
      const blockedDidPortfolio = await restClient.portfolios.getPortfolio(blocked.did, '0');
      expect(blockedDidPortfolio.assetBalances.find((b) => b.asset === assetId)?.free).toBe(
        blockedBalance.toString()
      );
      return;
    }

    const instruction = await restClient.settlements.getInstruction(blockedInstructionId);

    expect(instruction).toEqual(
      expect.objectContaining({
        status: InstructionStatus.Failed,
      })
    );
  });

  it('should be possible to send an asset to a blocked did after pausing compliance requirements', async () => {
    const txData = await restClient.compliance.pauseRequirements(assetId, signerTxBase);

    expect(txData).toEqual(assertTagPresent(expect, 'complianceManager.pauseAssetCompliance'));

    const { result: blockedReceiverInstruction, instructionId: blockedId } =
      await createVenueInstruction(
        restClient,
        factory.polymeshSdk,
        venueId,
        fungibleInstructionParams(assetId, issuer.did, blocked.did, {
          options: { signer: issuer.signer, processMode: ProcessMode.Submit },
        })
      );

    if (!isInstructionPurgedError(blockedReceiverInstruction)) {
      expect(blockedReceiverInstruction).toEqual(
        assertTagPresent(expect, 'settlement.addAndAffirmWithMediators')
      );
    }

    blockedInstructionId = blockedId ?? getInstructionId(blockedReceiverInstruction);
    blockedBalance += 10;

    if (blockedInstructionId) {
      const blockedAffirmResult = await restClient.settlements.affirmInstruction(
        blockedInstructionId,
        blockedTxBase
      );

      if (!isAlreadyAffirmedError(blockedAffirmResult)) {
        expect(blockedAffirmResult).toEqual(
          assertTagPresent(expect, 'settlement.affirmInstructionWithCount')
        );
      }
    }

    const blockedDidPortfolio = await restClient.portfolios.getPortfolio(blocked.did, '0');

    expect(blockedDidPortfolio).toEqual(
      expect.objectContaining({
        assetBalances: expect.arrayContaining([
          expect.objectContaining({
            asset: assetId,
            free: blockedBalance.toString(),
          }),
        ]),
      })
    );
  });
});
