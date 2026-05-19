import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { OrderStatus, UserRole } from '@prisma/client';
import { Request } from 'express';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { CreateOrderDto } from './dto/create-order.dto';
import { RateOrderDto } from './dto/rate-order.dto';
import { RefuseOrderDto } from './dto/vendor-decision.dto';
import { SetItemPreparedDto } from './dto/set-item-prepared.dto';
import { VendorCancelPreOrderDto } from './dto/vendor-cancel-pre-order.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // ── consumer routes ────────────────────────────────────────────────

  @Post()
  @ApiOperation({
    summary: 'Create order from cart (Story 3.1)',
    description:
      'Validates cart against vendor + items + stock, computes fee/total server-side, ' +
      'enforces minimum order. Idempotent via `Idempotency-Key` header (Story 3.14): a ' +
      'retried request with the same key returns the original order. ' +
      'Error codes: vendor_not_found, vendor_closed, item_not_in_vendor_menu, ' +
      'item_out_of_stock, order_below_minimum.',
  })
  create(
    @Req() req: Request,
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.orders.createOrder((req.user as { id: string }).id, dto, idempotencyKey);
  }

  @Get()
  @ApiOperation({ summary: 'List own orders (recent first, max 30)' })
  listMine(@Req() req: Request) {
    return this.orders.listConsumerOrders((req.user as { id: string }).id);
  }

  @Get(':orderId')
  @ApiOperation({
    summary: 'Order detail',
    description: 'Visible to the consumer who placed it AND to the target vendor.',
  })
  detail(@Req() req: Request, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.orders.getOrder(orderId, (req.user as { id: string }).id);
  }

  @Public()
  @Get(':orderId/public')
  @ApiOperation({
    summary: 'Public order status (no auth — UUID-as-token model)',
    description:
      'Returns only non-PII fields (order code, status, vendor name, lifecycle ' +
      'timestamps) so consumers can share the link with friends/family without ' +
      'exposing payment info, delivery code, or contact details. UUID-as-token: ' +
      'the order id is the access key — treat the link as semi-secret.',
  })
  detailPublic(@Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.orders.getOrderPublic(orderId);
  }

  @Patch(':orderId/cancel')
  @ApiOperation({
    summary: 'Consumer cancel — only before vendor acceptance (Story 3.8)',
    description:
      'Cash orders cancel cleanly. MoMo orders enter cancelled state immediately; ' +
      'the refund is processed asynchronously by the payments module.',
  })
  cancel(@Req() req: Request, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.orders.cancelOrder(orderId, (req.user as { id: string }).id);
  }

  @Post(':orderId/rating')
  @ApiOperation({
    summary: 'Rate vendor + rider post-delivery (Story 3.9)',
    description:
      'Both scores required. 24h window from deliveredAt. One rating per order. ' +
      'Error codes: order_not_rateable, order_already_rated, rating_window_expired.',
  })
  rate(
    @Req() req: Request,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: RateOrderDto,
  ) {
    return this.orders.rateOrder(orderId, (req.user as { id: string }).id, dto);
  }

  // ── vendor routes ──────────────────────────────────────────────────

  @Roles(UserRole.VENDOR)
  @Get('vendor/me')
  @ApiOperation({
    summary: 'Vendor inbox — list own orders (Story 3.7, pre-orders #187)',
    description:
      'Optional `status` query filters to a single state — pass `CONFIRMED` for "awaiting decision". ' +
      'Optional `type` query splits immediate orders (default — scheduledFor=null, sorted placedAt DESC) ' +
      'from pre-orders (type=preorder — scheduledFor!=null, sorted scheduledFor ASC).',
  })
  @ApiQuery({ name: 'status', required: false, enum: OrderStatus })
  @ApiQuery({ name: 'type', required: false, enum: ['immediate', 'preorder'] })
  vendorList(
    @Req() req: Request,
    @Query('status') status?: OrderStatus,
    @Query('type') type?: 'immediate' | 'preorder',
  ) {
    return this.orders.listVendorOrders(
      (req.user as { id: string }).id,
      status,
      type === 'preorder' ? 'preorder' : 'immediate',
    );
  }

  @Roles(UserRole.VENDOR)
  @Patch(':orderId/accept')
  @ApiOperation({ summary: 'Vendor accepts an order (Story 3.7)' })
  accept(@Req() req: Request, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.orders.acceptOrder(orderId, (req.user as { id: string }).id);
  }

  @Roles(UserRole.VENDOR)
  @Patch(':orderId/refuse')
  @ApiOperation({
    summary: 'Vendor refuses with reason (Story 3.7)',
    description:
      'POWER_OUTAGE is non-penalising; everything else counts toward the weekly refusal alert.',
  })
  refuse(
    @Req() req: Request,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: RefuseOrderDto,
  ) {
    return this.orders.refuseOrder(orderId, (req.user as { id: string }).id, dto);
  }

  @Roles(UserRole.VENDOR)
  @Patch(':orderId/items/:itemId/prepared')
  @ApiOperation({
    summary: 'Vendor toggles a single article as prepared (preparation checklist)',
  })
  setItemPrepared(
    @Req() req: Request,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: SetItemPreparedDto,
  ) {
    return this.orders.setItemPrepared(
      orderId,
      itemId,
      (req.user as { id: string }).id,
      dto.prepared,
    );
  }

  @Roles(UserRole.VENDOR)
  @Patch(':orderId/ready')
  @ApiOperation({
    summary: 'Vendor marks an order ready for pickup — all items must be prepared first',
  })
  markReady(@Req() req: Request, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.orders.markOrderReady(orderId, (req.user as { id: string }).id);
  }

  @Roles(UserRole.VENDOR)
  @Patch(':orderId/vendor-cancel-preorder')
  @ApiOperation({
    summary:
      'Vendor cancels a pre-order they already accepted (#187). Triggers consumer refund + VendorPenalty.',
    description:
      'Only valid for pre-orders (scheduledFor != null) currently in ACCEPTED or IN_PREP. ' +
      'Pre-acceptance cancellations should use the regular refuse endpoint (no penalty). ' +
      'Returns the cancelled status + the penalty amount in FCFA.',
  })
  vendorCancelPreOrder(
    @Req() req: Request,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: VendorCancelPreOrderDto,
  ) {
    return this.orders.vendorCancelPreOrder(orderId, (req.user as { id: string }).id, dto.note);
  }
}
