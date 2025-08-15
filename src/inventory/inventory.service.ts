import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';

import { InventoryItem } from './entities/inventory-item.entity';
import { StockMovement } from './entities/stock-movement.entity';
import { StockAdjustment } from './entities/stock-adjustment.entity';
import { ValuationRecord, ValuationMethod } from './entities/valuation-record.entity';

import { MoveStockDto, TransferStockDto, AdjustStockDto } from './dto/inventory.dto';
import { InventoryGateway } from './inventory.gateway';

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(InventoryItem)
    private readonly itemRepo: Repository<InventoryItem>,
    @InjectRepository(StockMovement)
    private readonly movementRepo: Repository<StockMovement>,
    @InjectRepository(StockAdjustment)
    private readonly adjustmentRepo: Repository<StockAdjustment>,
    @InjectRepository(ValuationRecord)
    private readonly valuationRepo: Repository<ValuationRecord>,
    private readonly inventoryGateway: InventoryGateway,
  ) {}


  async moveStock(dto: MoveStockDto) {
    await this.adjustInventory(dto.sku, dto.fromLocation, -dto.quantity);
    await this.adjustInventory(dto.sku, dto.toLocation, dto.quantity);
    const result = await this.movementRepo.save({
      sku: dto.sku,
      fromLocation: dto.fromLocation,
      toLocation: dto.toLocation,
      quantity: dto.quantity,
    });
    
    // Emit real-time movement event
    this.inventoryGateway.emitInventoryMovement({
      sku: dto.sku,
      fromLocation: dto.fromLocation,
      toLocation: dto.toLocation,
      quantity: dto.quantity,
      timestamp: new Date(),
    });
    
    return { success: true, message: 'Stock moved successfully', data: result };
  }

  async getStockLevels() {
    const data = await this.itemRepo.find();
    return { success: true, message: 'Stock levels retrieved', data };
  }

  async transferStock(dto: TransferStockDto) {
    const results = [];
    for (const move of dto.movements) {
      results.push(await this.moveStock(move));
    }
    return { success: true, message: 'Stock transfer completed', data: results };
  }

  async adjustStock(dto: AdjustStockDto) {
    await this.adjustInventory(dto.sku, dto.locationId, dto.quantityChange);
    const result = await this.adjustmentRepo.save({
      sku: dto.sku,
      locationId: dto.locationId,
      quantityChange: dto.quantityChange,
      reason: dto.reason,
    });
    return { success: true, message: 'Stock adjusted', data: result };
  }

  private async adjustInventory(sku: string, locationId: string, change: number) {
    let item = await this.itemRepo.findOne({ where: { sku, locationId } });
    if (!item) {
      item = this.itemRepo.create({ sku, locationId, quantity: 0 });
    }
    const previousQuantity = item.quantity;
    item.quantity += change;
    await this.itemRepo.save(item);
    
    // Emit real-time stock update
    this.inventoryGateway.emitStockUpdate({
      sku,
      locationId,
      quantity: item.quantity,
      previousQuantity,
      change,
    });
    
    // Check for low stock alert (assuming threshold of 10)
    const threshold = 10;
    if (item.quantity <= threshold && previousQuantity > threshold) {
      this.inventoryGateway.emitLowStockAlert({
        sku,
        locationId,
        currentQuantity: item.quantity,
        threshold,
      });
    }
  }

  // ——— Valuation helpers ———

  /** Fetch adjustments up to an optional date, oldest first */
  private async getAdjustments(sku: string, asOf?: Date) {
    return this.adjustmentRepo.find({
      where: {
        sku,
        adjustedAt: asOf ? LessThanOrEqual(asOf) : undefined,
      },
      order: { adjustedAt: 'ASC' },
    });
  }

  /** FIFO costing */
  async calculateFifo(sku: string, asOf?: Date) {
    const events = await this.getAdjustments(sku, asOf);
    let qty = 0, costSum = 0;
    for (const e of events) {
      const cost = (e as any).unitCost ?? 0; 
      if (e.quantityChange > 0) {
        qty += e.quantityChange;
        costSum += cost * e.quantityChange;
      } else {
        const remove = Math.min(qty, -e.quantityChange);
        const avgCost = qty ? costSum / qty : 0;
        qty    -= remove;
        costSum -= avgCost * remove;
      }
    }
    const unitCost = qty ? costSum / qty : 0;
    return { unitCost, quantityOnHand: qty, totalValue: unitCost * qty };
  }

  /** LIFO costing */
  async calculateLifo(sku: string, asOf?: Date) {
    const events = await this.getAdjustments(sku, asOf);
    events.reverse();
    let qty = 0, costSum = 0;
    for (const e of events) {
      const cost = (e as any).unitCost ?? 0;
      if (e.quantityChange > 0) {
        qty += e.quantityChange;
        costSum += cost * e.quantityChange;
      } else {
        const remove = Math.min(qty, -e.quantityChange);
        const avgCost = qty ? costSum / qty : 0;
        qty    -= remove;
        costSum -= avgCost * remove;
      }
    }
    const unitCost = qty ? costSum / qty : 0;
    return { unitCost, quantityOnHand: qty, totalValue: unitCost * qty };
  }

  /** Weighted-average costing */
  async calculateAverage(sku: string, asOf?: Date) {
    const events  = await this.getAdjustments(sku, asOf);
    const receipts = events.filter(e => e.quantityChange > 0);
    const issues   = events.filter(e => e.quantityChange < 0);

    const totalRecQty  = receipts.reduce((s, e) => s + e.quantityChange, 0);
    const totalRecCost = receipts.reduce((s, e) => s + (e.quantityChange * ((e as any).unitCost ?? 0)), 0);
    const onHandQty    = totalRecQty - issues.reduce((s, e) => s + -e.quantityChange, 0);

    const unitCost = totalRecQty ? totalRecCost / totalRecQty : 0;
    return { unitCost, quantityOnHand: onHandQty, totalValue: unitCost * onHandQty };
  }

  /** Persist a ValuationRecord snapshot */
  async snapshotValuation(sku: string, method: ValuationMethod, asOf?: Date) {
    const item = await this.itemRepo.findOne({ where: { sku } });
    if (!item) throw new NotFoundException(`No inventory item for SKU ${sku}`);

    let result;
    switch (method) {
      case ValuationMethod.FIFO:
        result = await this.calculateFifo(sku, asOf);
        break;
      case ValuationMethod.LIFO:
        result = await this.calculateLifo(sku, asOf);
        break;
      default:
        result = await this.calculateAverage(sku, asOf);
    }

    const rec = this.valuationRepo.create({
      inventoryItem: item,
      method,
      unitCost: result.unitCost,
      quantityOnHand: result.quantityOnHand,
      totalValue: result.totalValue,
    });
    return this.valuationRepo.save(rec);
  }
}
