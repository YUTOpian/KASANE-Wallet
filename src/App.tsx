import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import NodeSwitchNotice from './components/NodeSwitchNotice';
import TxNoticeSnackbar from './components/TxNoticeSnackbar';
import SssLinkWatcher from './components/SssLinkWatcher';

function App() {
  return (
    <>
      <RouterProvider router={router} />
      <NodeSwitchNotice />
      <TxNoticeSnackbar />
      <SssLinkWatcher />
    </>
  );
}

export default App;
