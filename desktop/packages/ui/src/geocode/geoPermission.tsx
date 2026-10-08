import React from 'react';

import type { PermissionRequest } from '@/types/permission';

import { GeeRunPermission } from './GeeRunPermission';
import { QgisRunPermission } from './QgisRunPermission';

/** A geo tool's own permission card body in place of the generic one; undefined for any other request. */
export const geoPermissionContent = (permission: PermissionRequest): React.ReactNode | undefined => {
  if (permission.action === 'qgisrun') return <QgisRunPermission permission={permission} />;
  if (permission.action === 'geerun') return <GeeRunPermission permission={permission} />;
  return undefined;
};
