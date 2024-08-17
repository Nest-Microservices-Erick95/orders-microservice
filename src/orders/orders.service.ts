import { HttpStatus, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { PrismaClient } from '@prisma/client';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { PaginationDto } from 'src/common/dto/pagination.dto';
import { OrderPaginationDto } from './dto/order-pagination.dto';
import { ChangeOrderStatusDto } from './dto/change-order-status.dto';
import { NATS_SERVICE } from 'src/config/services';
import { firstValueFrom } from 'rxjs';
import { OrderWithProducts } from './interfaces/order-with-products.interface';
import { PaidOrderDto } from './dto/paid-order.dto';

@Injectable()
export class OrdersService extends PrismaClient implements OnModuleInit {

  async onModuleInit() {
    await this.$connect();
  }

  constructor(
    @Inject(NATS_SERVICE) 
    private readonly client: ClientProxy 
  ) {
    super();
  }

  async create(createOrderDto: CreateOrderDto) {

    try { 
      const productsIds: number[] = createOrderDto.items.map(item => item.productId);
      
      const products: any[] = await firstValueFrom(
        this.client.send({ cmd: 'validate_products' }, productsIds)
      );

      const totalAmount = createOrderDto.items.reduce((acc, orderItem) => { 
        const price = products.find(
          (product) => product.id === orderItem.productId
        ).price; 
        return acc + (price * orderItem.quantity);
      }, 0);

      const totalItems = createOrderDto.items.reduce((acc, orderItem) => {
        return acc + orderItem.quantity;
      }, 0);

      const order = await this.order.create({ 
        data: {
          totalAmount,
          totalItems,
          orderItem: {
            createMany: {
              data: createOrderDto.items.map((orderItem) => ({
                price: products.find(product => product.id === orderItem.productId).price, 
                productId: orderItem.productId,
                quantity: orderItem.quantity
              }))
            }
          }
        },
        include: { 
          orderItem: {
            select: { 
              price: true,
              quantity: true,
              productId: true
            }
          }
        }
      });

      return {
        ...order,
        orderItem: order.orderItem.map((orderItem) => ({
          ...orderItem,
          name: products.find(product => product.id === orderItem.productId).name
        }))
      };
    } catch(error) {
      throw new RpcException(error);
    }

  }

  async findAll(orderPaginationDto: OrderPaginationDto) {
    const { page, limit, status } = orderPaginationDto;
    const total = await this.order.count({ where: status ? { status } : {} });
    const lastPage = Math.ceil(total / limit);
    const perPage = limit;

    return {
      data: await this.order.findMany({ 
        skip: (page - 1) * limit,
        take: limit,
        where: status ? { status } : {}
      }),
      meta: {
        total,
        page, 
        lastPage, 
        isLastPage: page === lastPage, 
        isFirstPage: page === 1, 
        perPage 
      }
    };
  }

  async findOne(id: string) {
    const order = await this.order.findFirst({
      where: { id },
      include: {
        orderItem: {
          select: {
            price: true,
            quantity: true,
            productId: true
          }
        }
      }
    });

    if(!order) {
      throw new RpcException({
        message: `Order with id ${id} not found`,
        status: HttpStatus.NOT_FOUND
      });
    }

    try {
      const productsIds = order.orderItem.map(item => item.productId);

      const products: any[] = await firstValueFrom(
        this.client.send({ cmd: 'validate_products' }, productsIds)
      );
  
      return {
        ...order,
        orderItem: order.orderItem.map((orderItem) => ({
          ...orderItem,
          name: products.find(product => product.id === orderItem.productId).name
        }))
      };
    } catch(error) {
      throw new RpcException(error);
    }

  }

  async changeStatus(changeStatusDto: ChangeOrderStatusDto) {
    const { id, status } = changeStatusDto;

    const order = await this.findOne(id);
    
    if(order.status === status) return order;

    return this.order.update({
      where: { id },
      data: { status }
    });
  }


  async createPaymentSession(order: OrderWithProducts) {
    try {
      const paymentSession = await firstValueFrom( 
        this.client.send('create.payment.session', {
          orderId: order.id,
          currency: 'usd',
          items: order.orderItem.map(item => ({
            name: item.name,
            price: item.price,
            quantity: item.quantity
          }))
        })
      );
      return paymentSession;
    } catch(error) {
      throw new RpcException(error);
    }

  }


  async paidOrder(paidOrderDto: PaidOrderDto) {
    const order = await this.order.update({
      where: { id: paidOrderDto.orderId },
      data: {
        status: 'PAID',
        paid: true,
        paidAt: new Date(),
        stripeChargeId: paidOrderDto.stripePaymentId,
        OrderReceipt: {
          create: { 
            receiptUrl: paidOrderDto.receiptUrl
          }
        }
      }
    });

    return order;
  }

}
