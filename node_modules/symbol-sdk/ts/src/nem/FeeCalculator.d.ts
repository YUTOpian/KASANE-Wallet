/**
 * Calculates the minimum required mosaic rental fee.
 * @returns {bigint} Rental fee.
 */
export function calculateMosaicRentalFee(): bigint;
/**
 * Calculates the minimum required namespace rental fee.
 * @param {boolean} isRoot \c true if the fee should be calculated for a root namespace.
 * @returns {bigint} Rental fee.
 */
export function calculateNamespaceRentalFee(isRoot: boolean): bigint;
/**
 * Calculates the minimum required transaction fee for a transaction.
 * @param {nc.Transaction} transaction Transaction.
 * @param {Function|{[key: string]: object}|undefined} mosaicInformationLookup
 * Looks up mosaic information ({supply, divisibility}) given mosaic identifier.
 * When a function, mosaic identifier will be passed as parameter.
 * When an object map, fully qualified mosaic identifier will be used as an index.
 * When undefined, this function will be unable to calculate fees for custom mosaic transfers.
 * @returns {bigint} Transaction fee.
 */
export function calculateTransactionFee(transaction: nc.Transaction, mosaicInformationLookup?: Function | {
    [key: string]: object;
} | undefined): bigint;
import * as nc from './models.js';
