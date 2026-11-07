// Worker の本体（consoleWorker.ts）を、単一HTMLビルドの中に Blob として埋め込んで作る。
// ここだけが `?worker&inline` を import する（テストは Node で動くので、consoleRunner.ts には import させない）。
import ConsoleWorker from './consoleWorker?worker&inline';

export const spawnConsoleWorker = (): Worker => new ConsoleWorker({ name: 'kasane-console' });
