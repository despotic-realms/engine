import { fx } from './fx.js';

export const ECON = {
  GRAIN_PRICE: fx('0.5'),      // treasury per grain unit
  AUDIT_COST: fx('20'),
  CONSUME_PER_POP: fx('0.2'),  // grain per person per tick
  BASE_YIELD: fx('2.4'),       // grain per farmland unit at median weather
  LIEGE_TAX: fx('120'),        // due every winter tick
  INVEST_MATURITY_TICKS: 8,    // two years — the ten-tick-payoff probe
  LEVY_RAISE_COST: fx('0.8'),  // treasury per levy unit raised
  LEVY_UPKEEP: fx('0.15'),     // treasury per levy unit per tick
} as const;
