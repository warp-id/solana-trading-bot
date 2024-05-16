import * as fs from 'fs';
import * as moment from 'moment';
import 'moment-duration-format';

export interface TradeData {
  amountIn: number,
  amountOut: number,
  fee: number,
  start: Date,
  end: Date,
  time_to_entry: string,
  time_to_exit: string,
  profit: number,
  profitPercent: number,
  balance: number,
  mint: string,
  status: string,
  id: number
}

export class Trade {
  private data: TradeData
  private transition_start: number
  private transition_end: number

  constructor(
    private readonly mint: string,
    private readonly logFilename: string
  ) {
    this.data = {
      mint: mint,
      amountIn: 0,
      amountOut: 0,
      fee: 0,
      profit: 0,
      profitPercent: 0,
      start: new Date(),
      end: new Date(),
      time_to_entry: '0',
      time_to_exit: '0',
      balance: 0,
      status: 'initiated',
      id: 0,
    };

    this.transition_start = 0;
    this.transition_end = 0;
    this.logFilename = logFilename;
  }

  // Help mesure entry and exit time of a trade
  transitionStart() {
    this.transition_start = Date.now();
  }

  // Help mesure entry and exit time of a trade
  transitionEnd() {
    this.transition_end = Date.now();
  }

  // Trade position entered
  open(amountIn: number, fee: number) {
    this.transition_end = Date.now();
    const duration = this.transition_end - this.transition_start;
    this.data.time_to_entry = moment.duration({ milliseconds: duration }).format();
    this.data.start = new Date();
    this.data.amountIn = amountIn;
    this.data.fee += fee;
    this.data.status = 'open';
  }

  // Trade position closed
  // Compute profit
  close(amountOut: number, fee: number, status: string) {
    this.transition_end = Date.now();
    const duration = this.transition_end - this.transition_start;
    this.data.time_to_exit = moment.duration({ milliseconds: duration }).format();
    this.data.end = new Date();
    this.data.amountOut = amountOut;
    this.data.fee += fee;
    this.data.profit = this.data.amountOut - this.data.amountIn - this.data.fee;
    this.data.profitPercent = (this.data.profit / this.data.amountIn) * 100;
    this.data.status = status;
  }

  // Trade completed, save data to log file
  completeAndLog(balance: number, id: number) {
    this.data.balance = balance;
    this.data.id = id;

    if (this.logFilename !== 'none') {
      try {
        fs.appendFileSync(this.logFilename, JSON.stringify(this.data) + '\n');
      } catch (err) {
        return err;
      }
    }
  }

  get profit() {
    return this.data.profit;
  }

  get amountIn() {
    return this.data.amountIn;
  }
}
