import { db } from '../../store/db';
import { cloud } from '../../cloud/state';
import { accountLifecycle } from '../../client/account-lifecycle';

/**
 * 「这轮异步回来时还能不能写状态」的判据：库实例没被换掉（换号会重建 db）、
 * 账号没变、这一代账号生命周期还活着，再由调用方补上「用户没切走会话」这一条。
 *
 * 前三条与会话无关，所以由本函数统一持有；第四条只有调用方知道该比哪一份快照。
 */
export function sessionWriteGuard(sessionIsCurrent: () => boolean) {
  const database = db, owner = cloud.userId, lifetime = accountLifecycle.current();
  return () => database === db && owner === cloud.userId && (!lifetime || lifetime.current()) && sessionIsCurrent();
}
