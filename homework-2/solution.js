// Заполняйте TODO. c — переданная база; функции выполняют реальные запросы MongoDB.
// Служебный lab.js менять не требуется. Контракты и порядок опытов — в Задание.md.
globalThis.installValidator = async db => {
  await db.runCommand({
    collMod: 'products',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'name', 'category', 'price', 'variants'],
        properties: {
          _id: { bsonType: 'string' },
          name: { bsonType: 'string' },
          category: { bsonType: 'string' },
          price: { bsonType: 'decimal', minimum: 0 },
          variants: {
            bsonType: 'array',
            items: {
              bsonType: 'object',
              required: ['size', 'stock'],
              properties: {
                size: { bsonType: 'string' },
                stock: { bsonType: ['int', 'long'], minimum: 0 }
              }
            }
          }
        }
      }
    },
    validationLevel: 'strict',
    validationAction: 'error'
  });
};

// Возврат: Promise массива полных Product; порядок _id ASC; [] при отсутствии.
globalThis.searchProducts = async (db, {category, size, qty}) => {
  return db.products.find({
    category,
    variants: { $elemMatch: { size, stock: { $gte: qty } } }
  }).sort({ _id: 1 }).toArray();
};

// Технический helper: верните MongoDB cursor с фильтром, сортировкой и limit.
// Один и тот же запрос используется для результата и explain в опыте с индексом.
globalThis.historyCursor = (db, {userId, status}) => {
  return db.orders.find({ userId, status })
    .sort({ createdAt: -1, _id: 1 })
    .limit(20);
};
globalThis.history = async (db, input) => historyCursor(db, input).toArray();

// Заполните порядок полей и направления индекса для historyCursor.
globalThis.historyIndex = { userId: 1, status: 1, createdAt: -1, _id: 1 };
// Если добавили hint в historyCursor, измените флаг на true.
globalThis.usesHistoryHint = false;

// Возврат: Promise массива {sku, name, qty, revenue}; revenue — Decimal128.
globalThis.report = async (db, from, to) => {
  return db.orders.aggregate([
    { $match: { status: 'paid', createdAt: { $gte: from, $lt: to } } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.sku',
        qty: { $sum: '$items.qty' },
        revenue: { $sum: { $multiply: ['$items.qty', '$items.price'] } }
      }
    },
    { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'p' } },
    { $unwind: { path: '$p', preserveNullAndEmptyArrays: true } },
    { $project: { _id: 0, sku: '$_id', name: '$p.name', qty: 1, revenue: 1 } },
    { $sort: { revenue: -1, sku: 1 } },
    { $limit: 5 }
  ]).toArray();
};

// request: {operationId, userId, items:[{sku,size,qty},{sku,size,qty}]}.
// Входы соответствуют контракту задания. Два SKU различны; порядок items значим.
// Возврат: Promise созданного или ранее сохранённого Order.
// При отказе: throw HWError('ITEM_UNAVAILABLE') или HWError('REQUEST_CONFLICT').
// Сообщение ошибки свободное; сценарий проверяет только error.code.
// transaction(body) предоставлена: body получает c — базу в активной сессии.
// Все операции покупки внутри body выполняйте через этот c.
globalThis.purchase = async (request, trace = () => {}) => {
  return transaction(async db => {
    const operationId = request.operationId;
    const userId = request.userId;
    const items = request.items;

    const existing = await db.orders.findOne({ _id: operationId });
    if (existing) {
      let sameRequest = Number(existing.userId) === userId && existing.items.length === items.length;
      if (sameRequest) {
        for (let i = 0; i < items.length; i++) {
          const saved = existing.items[i];
          const req = items[i];
          if (saved.sku !== req.sku || saved.size !== req.size || Number(saved.qty) !== req.qty) {
            sameRequest = false;
            break;
          }
        }
      }
      if (sameRequest) return existing;
      throw HWError('REQUEST_CONFLICT');
    }

    const orderItems = [];
    for (const item of items) {
      const product = await db.products.findOne({ _id: item.sku, 'variants.size': item.size });
      if (!product) throw HWError('ITEM_UNAVAILABLE');
      const result = await db.products.updateOne(
        { _id: item.sku, variants: { $elemMatch: { size: item.size, stock: { $gte: item.qty } } } },
        { $inc: { 'variants.$.stock': -item.qty } }
      );
      trace({ event: 'update_inside_transaction', sku: item.sku, matched: result.matchedCount, modified: result.modifiedCount });
      if (result.matchedCount === 0) throw HWError('ITEM_UNAVAILABLE');
      orderItems.push({ sku: item.sku, size: item.size, qty: NumberInt(item.qty), price: product.price });
    }

    const order = { _id: operationId, userId: NumberInt(userId), createdAt: new Date(), status: 'created', items: orderItems };
    await db.orders.insertOne(order);
    return order;
  });
};

// Используйте именно переданный c: он связан с одним MongoDB-клиентом опыта.
// writeProbe: сохранить {_id:id, message} в c.probe с majority и j:true.
// Возврат — результат записи с acknowledged:true. Повтор вызова с тем же id
// должен быть безопасен: оболочка опыта может повторить запись после ошибки связи.
globalThis.writeProbe = async (db, id, message) => {
  return db.probe.updateOne(
    { _id: id },
    { $set: { message } },
    { upsert: true, writeConcern: HW.wc }
  );
};
// Возврат — документ c.probe с указанным _id либо null.
globalThis.readProbe = async (db, id) => {
  return db.probe.findOne({ _id: id });
};