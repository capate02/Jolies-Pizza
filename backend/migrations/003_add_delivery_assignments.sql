USE jolies_pizza;

CREATE TABLE IF NOT EXISTS delivery_assignments (
    order_id BIGINT NOT NULL PRIMARY KEY,
    assigned_by_email VARCHAR(190) NOT NULL,
    rider_name VARCHAR(190) NOT NULL,
    rider_phone VARCHAR(30) NOT NULL,
    vehicle_description VARCHAR(100) NULL,
    license_plate VARCHAR(30) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_delivery_assignments_order
        FOREIGN KEY (order_id)
        REFERENCES customer_orders(id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
