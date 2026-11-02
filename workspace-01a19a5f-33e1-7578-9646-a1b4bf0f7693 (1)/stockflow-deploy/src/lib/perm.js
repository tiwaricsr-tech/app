'use strict';

const PERMISSIONS = [
  ['products.view', 'View products and stock'],
  ['products.create', 'Create products'],
  ['products.update', 'Edit products'],
  ['products.delete', 'Archive / delete products'],
  ['stock.adjust', 'Increase, decrease and adjust stock'],
  ['inventory.view', 'View inventory and stock movements'],
  ['invoices.view', 'View invoices'],
  ['invoices.create', 'Create invoices / bills'],
  ['invoices.edit', 'Edit invoices'],
  ['invoices.cancel', 'Cancel or refund invoices'],
  ['reports.view', 'View reports and export PDF/Excel'],
  ['users.view', 'View user accounts'],
  ['users.manage', 'Activate / deactivate users and change roles'],
  ['categories.manage', 'Create and edit categories']
];

const ROLE_MATRIX = {
  admin: PERMISSIONS.map(([code]) => code),
  manager: [
    'products.view', 'products.create', 'products.update', 'products.delete', 'stock.adjust',
    'inventory.view', 'invoices.view', 'invoices.create', 'invoices.edit', 'invoices.cancel',
    'reports.view', 'categories.manage'
  ],
  staff: ['products.view', 'inventory.view', 'invoices.view', 'invoices.create']
};

const ROLES = [
  { name: 'admin', label: 'Administrator', description: 'Full access to inventory, billing, users and reports' },
  { name: 'manager', label: 'Manager', description: 'Inventory management and billing, cannot manage users' },
  { name: 'staff', label: 'Billing Staff', description: 'Create invoices and view inventory' }
];

function permissionsForRole(roleName) {
  return ROLE_MATRIX[roleName] || [];
}

const PERMISSION_VERBS = {
  'products.view': 'view products', 'products.create': 'add products', 'products.update': 'edit products',
  'products.delete': 'delete products', 'stock.adjust': 'adjust stock', 'inventory.view': 'view inventory',
  'invoices.view': 'view invoices', 'invoices.create': 'create bills', 'invoices.edit': 'edit invoices',
  'invoices.cancel': 'cancel or refund invoices', 'reports.view': 'view reports', 'users.view': 'view users',
  'users.manage': 'manage user accounts', 'categories.manage': 'manage categories'
};

function roleCan(roleName, permission) {
  return permissionsForRole(roleName).includes(permission);
}

module.exports = { PERMISSIONS, ROLE_MATRIX, ROLES, PERMISSION_VERBS, permissionsForRole, roleCan };
