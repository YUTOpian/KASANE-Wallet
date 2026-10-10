/**
 * A single Symbol transfer, shaped for display in TransactionList / TransactionDetail.
 * When a transfer carries several mosaics, `amount` / `currencySymbol` describe the first one and
 * `extraMosaicCount` says how many more there are (the full list is in `mosaics`).
 */
export interface TransactionMosaic {
  id: string;
  symbol: string;
  amount: string;
}

export class TransactionWrapper {
  readonly hash: string;
  readonly dateString: string;
  readonly timeString: string;
  readonly isReception: boolean;
  readonly isConfirmed: boolean;
  readonly senderAddress: string;
  readonly receiverAddress: string;
  readonly amount: string; // formatted amount of the first mosaic, e.g. "1000.5"
  readonly currencySymbol: string; // "XYM" or the mosaic's namespace name / id
  readonly mosaics: TransactionMosaic[];
  readonly message: string;
  readonly encryptedMessage: boolean;
  readonly feeAmount: string; // XYM fee; '' when unknown

  get peer(): string {
    return this.isReception ? this.senderAddress : this.receiverAddress;
  }

  get extraMosaicCount(): number {
    return Math.max(this.mosaics.length - 1, 0);
  }

  constructor(params: {
    hash: string;
    timestamp: Date;
    isReception: boolean;
    isConfirmed: boolean;
    senderAddress: string;
    receiverAddress: string;
    mosaics: TransactionMosaic[];
    message?: string;
    encryptedMessage?: boolean;
    feeAmount: string;
  }) {
    this.hash = params.hash;
    this.dateString = params.timestamp.toLocaleDateString();
    this.timeString = params.timestamp.toLocaleTimeString();
    this.isReception = params.isReception;
    this.isConfirmed = params.isConfirmed;
    this.senderAddress = params.senderAddress;
    this.receiverAddress = params.receiverAddress;
    this.mosaics = params.mosaics;
    this.amount = params.mosaics[0]?.amount ?? '0';
    this.currencySymbol = params.mosaics[0]?.symbol ?? '';
    this.message = params.message ?? '';
    this.encryptedMessage = params.encryptedMessage ?? false;
    this.feeAmount = params.feeAmount;
  }
}
