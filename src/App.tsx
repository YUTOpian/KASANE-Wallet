import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import NodeSwitchNotice from './components/NodeSwitchNotice';
import TxNoticeSnackbar from './components/TxNoticeSnackbar';

function App() {
  return (
    <>
      <RouterProvider router={router} />
      <NodeSwitchNotice />
      <TxNoticeSnackbar />
    </>
  );
}

export default App;
