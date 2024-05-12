import * as fs from 'fs';
import * as moment from 'moment';
import 'moment-duration-format';

export class Trade {
  private data = {
    mint: '',
    amountIn: 0,
    amountOut: 0,
    start: new Date(),
    end: new Date(),
    time_to_entry: '',
    time_to_exit: '',
    profit: 0,
    profitPercent: 0,
    balance: 0,
    status: '',
    id: 0,
  }

  private transition_start: Date
  private transition_end: Date

  constructor(
    private readonly mint: string,
    private readonly amountIn: number,
    private readonly logFilename: string
  ) {
    this.data.mint = mint;
    this.data.amountIn = amountIn;
    this.data.amountOut = 0;
    this.data.profit = 0;
    this.data.profitPercent = 0;
    this.data.start = new Date();
    this.data.end = new Date();
    this.data.time_to_entry = '0';
    this.data.time_to_exit = '0';
    this.data.balance = 0;
    this.data.status = 'initiated';
    this.data.id = 0;

    this.transition_start = new Date();
    this.transition_end = new Date();
    this.logFilename = logFilename;
  }

  // Help mesure entry and exit time of a trade
  transitionStart() {
    this.transition_start = new Date();
  }

  // Help mesure entry and exit time of a trade
  transitionEnd() {
    this.transition_end = new Date();
  }

  // Trade position entered
  open() {
    const duration = this.transition_end.getTime() - this.transition_start.getTime();
    this.data.time_to_entry = moment.duration({ milliseconds: duration }).format();
    this.data.start = new Date();
    this.data.status = 'open';
  }

  // Trade position exited
  close() {
    const duration = this.transition_end.getTime() - this.transition_start.getTime();
    this.data.time_to_exit = moment.duration({ milliseconds: duration }).format();
    this.data.status = 'closed';
  }

  // Trade failed to sell
  closeFailed() {
    this.data.profit = -this.data.amountIn.valueOf();
    this.data.profitPercent = -100;
    this.data.time_to_exit = '0';
    this.data.status = 'sell_failed';
  }

  // Trade sold, compute profit.
  computeProfit(amountOut: number, fee: number) {
    this.data.amountOut = amountOut;
    this.data.profit = this.data.amountOut - this.data.amountIn.valueOf() - 2 * fee;
    this.data.profitPercent = (this.data.profit / this.data.amountIn.valueOf()) * 100;
  }

  // Trade completed, save data to log file
  completeAndLog(balance: number, id: number) {
    this.data.balance = balance;
    this.data.end = new Date();
    this.data.id = id;

    if (this.logFilename !== 'none') {
      try {
        fs.appendFileSync(this.logFilename, JSON.stringify(this.data) + '\n');
      } catch (err) {
        return err;
      }
    }
  }
}
