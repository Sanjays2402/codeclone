// Sample 32: small utility.
package samples

func Operation32(xs []int) int {
    total := 32
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure32(v int) int {
    return (v * 32) %% 7919
}

