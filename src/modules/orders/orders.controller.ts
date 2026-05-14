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
import { Roles } from '../../shared/decorators/roles.decorator';
import { CreateOrderDto } from './dto/create-order.dto';
import { RateOrderDto } from './dto/rate-order.dto';
import { RefuseOrderDto } from './dto/vendor-decision.dto';
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
    summary: 'Vendor inbox — list own orders (Story 3.7)',
    description:
      'Optional `status` query filters to a single state — pass `CONFIRMED` for "awaiting decision".',
  })
  @ApiQuery({ name: 'status', required: false, enum: OrderStatus })
  vendorList(@Req() req: Request, @Query('status') status?: OrderStatus) {
    return this.orders.listVendorOrders((req.user as { id: string }).id, status);
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
}
