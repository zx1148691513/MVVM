class Vue {
    constructor(options) {
        this.$el = options.el
        this.$data = options.data
        let computed = options.computed
        this.methods = options.methods

        if (this.$el) {
            //将传入的数据转换为响应式（set/get）
            new Observer(this.$data)

            //将计算属性挂载到this.$data下
            /* {{data中的普通值}} => 正则匹配 => 生成watcher => 触发data中那个值的get方法收集watcher => 完成响应式

            *  {{计算方法}} => 正则匹配 => 生成watcher => 触发data中和计算方法相同属性名的get方法
            *               => get方法调用计算方法函数触发data中的普通值的get方法 => 收集挂载到全局上的watcher => 完成响应式
            *
            *  总结：需要在this.$data中定义和computed中同名的属性，此属性的get方法调用计算方法中定义的函数（set方法同理）
            **/
            Object.keys(computed).forEach(item => {
                Object.defineProperty(this.$data, item, {
                    get: () => {
                        return computed[item].call(this)
                    }
                })
            })

            //对视图进行模板编译
            new Compiler(this.$el, this)
        }
    }

}

//模板编译类
class Compiler {
    constructor(el, vm) {
        //el可能是一个具体元素，也可能是一个选择器，如果是选择器，就调用api获取具体元素
        if (typeof el === 'string')
            el = document.querySelector(el)
        this.el = el;
        this.vm = vm
        //指令编译工具
        this.complierUtil = {
            //根据路径表达式到树形对象中取到叶子节点的值
            getValue(vm, expr) {
                let res =  expr.split('.').reduce((data, current) => data[current], vm.$data)
                return JSON.stringify(res)
            },
            setValue(vm, expr, newValue) {
                expr.split('.').reduce((data, current, index, arr) => {
                    if (index === arr.length - 1) {
                        return data[current] = newValue
                    }
                    return data[current]
                }, vm.$data)
            },
            //处理v-model指令
            // node->处理的节点，expr->指令的值(也是data中数据的索引)
            model(node, expr) {
                //value值类型: xxx.xxx
                //将data中的值绑定到节点的value值上
                node.value = this.getValue(vm, expr)
                //生成一个观察者,vm中数据改变时,同时更新node.value的值
                new Watcher(vm, expr, () => {
                    node.value = this.getValue(vm, expr)
                })
                //input输入时,同时更改vm.$data的值
                node.addEventListener('input', (event) => this.setValue(vm, expr, event.target.value))
            },
            //处理text节点的编译
            text(node, content) { //content值类型为:{{xxx}}
                node.data = content.replace(/\{\{(.+?)\}\}/g, (...args) => {
                    //content值可能为多个{{aaa}},{{bbb}}
                    // args数组保存了每一个匹配到的{{xxx}}
                    //为每一个{{xxx}}表达式都添加一个观察者
                    new Watcher(vm, args[1], () => {
                        //数据改变时，重新找到所有{{xxx}}并替换
                        node.data = content.replace(/\{\{(.+?)\}\}/g, (...args) => this.getValue(vm, args[1]))
                    })
                    return this.getValue(vm, args[1])
                })
            },
            //处理v-on事件
            on(node, methodName, eventName) {
                node.addEventListener(eventName, (event) => {
                    vm.methods[methodName].call(vm, event)
                })
            }
        }
        //将el元素下的所有节点拷贝到一个fragment中进行编译(避免频繁操作dom)
        //如果这里采用fragment.appendChild(el),就会连同根元素div#app一起被插入
        //后面再执行el.appendChild(fragment),就会产生两个div#app元素
        //所以两次操作一定要有一次是遍历子元素插入，排除掉父元素
        let fragment = this.nodeToFragment(this.el)
        this.compiler(fragment)
        //编译完成的fragment重新插入el元素下
        el.appendChild(fragment)
    }

    //将一个元素下的所有节点拷贝到DocumentFragment()中
    nodeToFragment(el) {
        let fragment = document.createDocumentFragment()
        let child = el.firstChild
        while (child) {
            fragment.appendChild(child)
            child = el.firstChild
        }
        return fragment
    }

    //节点编译入口方法
    compiler(node) {
        node.childNodes.forEach(child => {
            if (child instanceof HTMLElement) {
                this.compilerElement(child)
                //元素节点可能存在子节点，需要递归深度遍历
                this.compiler(child)
            } else if (child instanceof Text) {
                this.compilerText(child)
            }
        })
    }

    //对于元素节点,查找vue指令（v-开头）进行处理
    compilerElement(node) {
        //elem.attributes是一个可迭代对象,包含{name,value}键值对,且name/value为string类型
        [...node.attributes].forEach(attr => {
            let {name, value} = attr
            //如果以v-开头，则是Vue指令，需要进一步处理
            if (name.startsWith('v-')) {
                let [, directive] = name.split('-') //去掉指令的v-开头
                let [directiveName, eventName] = directive.split(':')
                //处理node节点的{directive=value}指令
                this.complierUtil[directiveName](node, value, eventName)
            }
        })
    }

    //对于文本节点，查找{{}}语法进行处理
    compilerText(node) {
        //读取非元素节点的内容，使用data属性
        let content = node.data
        if (/\{\{(.+?)\}\}/.test(content)) {
            this.complierUtil['text'](node, content)
        }
    }
}

//数据劫持类
class Observer {
    constructor(data) {

        //数组方法重写
        let oldMethods = Array.prototype
        this.arrayMethods = Object.create(Array.prototype)
        const methods = [
            'push',
            'pop',
            'shift',
            'unshift',
            'splice',
            'reverse',
            'sort'
        ]
        methods.forEach(method => {
            //给arrayMethods新增方法
            const that = this
            this.arrayMethods[method] = function (...args) {
                //先调用数组原型上的旧方法
                let res = oldMethods[method].apply(this,args)
                let insert  //记录插入数组的元素
                switch (method) {
                    case 'push':
                    case 'unshift':
                        //'push' 'unshift' 方法所有参数都是新增元素
                        insert = args
                        break
                    case 'splice':
                        //'splice'方法第三个到最后的参数是新增元素
                        insert = args.slice(2)
                        break
                    default:
                        break
                }
               /* if(insert)
                    that.observe(data)*/
                console.log('数组更新了');
                this.__ob__.notify()
                return res
            }
        })
        this.observe(data)
    }

    //遍历所有数据,调用defineReactive转换为响应式
    observe(data) {
        /*if (data && data.constructor.name === 'Object') {
            Object.keys(data).forEach(key => {
                if(data[key].constructor.name === 'Array')
                    console.log(data[key]);
                //递归深度遍历,data[key]可能还是一个对象
                this.observe(data[key])
                this.defineReactive(data, key, data[key])
            })
        }*/
        //深度优先遍历，最外层的data必定是一个对象
        if (data && data.constructor.name === 'Object') {
            let stack = []
            stack.push(data)
            while(stack.length){
                let item = stack.pop()

                /*如果是对象，遍历所有属性值：
                        使用Object.defineProperty改为响应式
                        属性值是对象/数组：入栈等待继续深度遍历

                  如果是数组，修改原型链指向，遍历所有属性值：
                        属性值是对象/数组：入栈等待继续深度遍历
                        属性值是普通值，忽略  **/
                if(item.constructor.name === 'Object'){
                    Object.keys(item).forEach(key => {
                        this.defineReactive(item,key,item[key])
                        if(typeof item[key] === 'object' && item[key] !== null)
                            stack.push(item[key])
                    })
                }
                else if (item.constructor.name === 'Array'){
                    // console.log(item);
                    //数组原型指向自定义的对象
                    item.__proto__ = this.arrayMethods
                    item.forEach(key => {
                        if(typeof key === 'object' && key !== null)
                            stack.push(key)
                    })
                }
            }
        }
    }

    //将数据转化为响应式
    defineReactive(obj, key, value) {
        //为每一个数据创建Dep类存储它的观察者
        let dep = new Dep()
        if(value.constructor.name === 'Array'){
            value.__ob__ = dep
            Object.defineProperty(obj, key, {
                get: () => {
                    //如果存在观察者,就保存到dep中
                    if (Dep.target)
                        dep.add(Dep.target)
                    console.log(key,dep.watchers);
                    return value
                },
            })
        }
        else
            Object.defineProperty(obj, key, {
                get: () => {
                    //如果存在观察者,就保存到dep中
                    if (Dep.target)
                        dep.add(Dep.target)
                    // console.log(key,dep.watchers);
                    return value
                },
                set: (newValue) => {
                    if (newValue !== value) {
                        //newValue可能是一个对象,需要递归遍历他的值
                        this.observe(newValue)
                        value = newValue
                        //数据改变,通知所有观察者
                        dep.notify()
                    }

                }
            })
    }
}

//观察者类(生成一个观察者):具体表现为观察vm实例中的一个数据，数据变化时，触发回调
class Watcher {
    //expr为依赖的数据在vm实例中的位置,当数据发生变化时，触发cb
    constructor(vm, expr, cb) {
        this.vm = vm
        this.expr = expr
        this.cb = cb
        this.oldValue = this.getValue(vm, expr)
    }

    //每次创建观察者时,都会立即调用getValue方法,获取观察者观测的那个数据
    //此时将会触发那个数据的get方法
    //这时将这个观察者保存到全局变量Dep.target上
    //就可以在对应数据的get方法中获取到这个观察者,并且保存到那个数据自己的dep数组中
    //只要数据发生了变化，就在set方法中调用此观察者的update()方法更新视图
    getValue(vm, expr) {
        Dep.target = this
        //执行此行即会触发数据的get方法保存观察者
        let data = expr.split('.').reduce((data, current) => data[current], vm.$data)
        //保存观察者完成后将target置空,避免重复保存
        Dep.target = null
        return data
    }

    update() {
        let newValue = this.getValue(this.vm, this.expr)
        if (newValue !== this.oldValue)
            //数据更新时触发回调
            this.cb()
    }

}

//存储/触发观察者类
class Dep {
    constructor() {
        this.watchers = []
    }

    add(watcher) {
        this.watchers.push(watcher)
    }

    notify() {
        this.watchers.forEach(watcher => watcher.update())
    }
}
