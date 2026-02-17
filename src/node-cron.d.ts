declare module 'node-cron' {
  interface ScheduledTask {
    start(): void;
    stop(): void;
  }

  function schedule(expression: string, func: () => void): ScheduledTask;
  function validate(expression: string): boolean;

  const _default: {
    schedule: typeof schedule;
    validate: typeof validate;
  };
  export default _default;
  export { ScheduledTask };
}
