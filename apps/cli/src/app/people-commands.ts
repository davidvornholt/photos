import { Command } from 'effect/cli';

export const people = Command.make('people').pipe(
  Command.withDescription('Not built yet'),
);
