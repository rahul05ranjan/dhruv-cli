// Example Dhruv CLI plugin
/* global console */
export default (program) => {
  program
    .command('hello-plugin')
    .description('Say hello from a plugin')
    .action(() => {
      console.log('👋 Hello from the Dhruv plugin system!');
    });
};
