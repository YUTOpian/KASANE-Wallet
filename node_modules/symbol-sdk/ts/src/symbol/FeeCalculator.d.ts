/**
 * Calculates the minimum required transaction fee for a transaction.
 * @param {sc.Transaction} transaction Transaction.
 * @param {number} feeMultiplier Fee multiplier to use.
 * @param {number} cosignatureCount Number of expected cosignatures to be attached.
 * @returns {bigint} Transaction fee.
 */
export function calculateTransactionFee(transaction: sc.Transaction, feeMultiplier: number, cosignatureCount?: number): bigint;
import * as sc from './models.js';
