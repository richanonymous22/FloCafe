/**
 * Supplier HTTP surface (Milestone 5). Thin handlers only — logic lives in
 * main/modules/purchasing/suppliers.ts.
 */

import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import { createSupplier, updateSupplier, getSupplier, listSuppliers, deactivateSupplier } from '../modules/purchasing/suppliers';

const router = Router();

function statusFor(error: any): number {
  return typeof error?.statusCode === 'number' ? error.statusCode : 500;
}

router.get('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const search = req.query.search ? String(req.query.search) : undefined;
  const activeOnly = req.query.active === 'true';
  res.json({ suppliers: listSuppliers({ search, activeOnly }) });
});

router.get('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  const supplier = getSupplier(String(req.params.id));
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  res.json({ supplier });
});

router.post('/', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const supplier = createSupplier({
      name: body.name,
      businessName: body.business_name,
      contactPerson: body.contact_person,
      phone: body.phone,
      email: body.email,
      address: body.address,
      notes: body.notes,
      taxRegistrationNumber: body.tax_registration_number,
      isActive: body.is_active,
    });
    res.status(201).json({ supplier });
  } catch (error: any) {
    const status = statusFor(error);
    if (status >= 500) console.error('[Suppliers] create failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
});

router.put('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const supplier = updateSupplier(String(req.params.id), {
      name: body.name,
      businessName: body.business_name,
      contactPerson: body.contact_person,
      phone: body.phone,
      email: body.email,
      address: body.address,
      notes: body.notes,
      taxRegistrationNumber: body.tax_registration_number,
      isActive: body.is_active,
    });
    res.json({ supplier });
  } catch (error: any) {
    const status = statusFor(error);
    if (status >= 500) console.error('[Suppliers] update failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
});

router.delete('/:id', requireRole('owner', 'manager'), (req: Request, res: Response) => {
  try {
    deactivateSupplier(String(req.params.id));
    res.status(204).send();
  } catch (error: any) {
    const status = statusFor(error);
    if (status >= 500) console.error('[Suppliers] deactivate failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
});

export const supplierRoutes = router;
