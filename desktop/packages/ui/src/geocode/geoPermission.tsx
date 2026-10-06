import React from 'react';

import type { PermissionRequest } from '@/types/permission';

import { QgisRunPermission } from './QgisRunPermission';

/** A geo tool's own permission card body in place of the generic one; undefined for any other request. */
export const geoPermissionContent = (permission: PermissionRequest): React.ReactNode | undefined =>
  permission.action === 'qgisrun' ? <QgisRunPermission permission={permission} /> : undefined;
