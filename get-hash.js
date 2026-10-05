const bcrypt = require('bcryptjs');
bcrypt.hash('P@$$w0rld+8,', 10, (err, hash) => {
  console.log("YOUR HASH:", hash);
});