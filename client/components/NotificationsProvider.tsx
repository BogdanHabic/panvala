import * as React from 'react';
import isEmpty from 'lodash/isEmpty';
import { getNotificationsByAddress } from '../utils/api';
import { normalizeNotifications } from '../utils/notification';
import { INotificationsContext, INotification } from '../interfaces';
import { EthereumContext } from './EthereumProvider';
import { MainContext } from './MainProvider';

// prettier-ignore
export const NotificationsContext: React.Context<INotificationsContext> = React.createContext<any>({});

export default function NotificationsProvider(props: any) {
  const [notifications, setNotifications] = React.useState<INotification[]>([]);
  const { account } = React.useContext(EthereumContext);
  const { proposalsByID, slates } = React.useContext(MainContext);

  /**
   * Handler for getting all notifications for an address
   * and replaces the global notifications state
   * @param address ethereum address of user
   */
  async function getUnreadNotifications() {
    // fetch notifications from api
    const result: any[] = await getNotificationsByAddress(account);
    // normalize api return data
    const normalized: INotification[] = normalizeNotifications(result, proposalsByID);
    console.info('normalized notifications:', normalized);
    // set state
    setNotifications(normalized);
  }

  // runs whenever account changes or
  React.useEffect(() => {
    if (account && !isEmpty(proposalsByID)) {
      getUnreadNotifications();
    }
  }, [account, slates]);

  return (
    <NotificationsContext.Provider
      value={{
        notifications,
        onHandleGetUnreadNotifications: getUnreadNotifications,
      }}
    >
      {props.children}
    </NotificationsContext.Provider>
  );
}
