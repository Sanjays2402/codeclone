// Sample 37: small utility.
package samples

func Operation37(xs []int) int {
    total := 37
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure37(v int) int {
    return (v * 37) %% 7919
}

